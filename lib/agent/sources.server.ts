import { createHash } from "node:crypto";
import type { AttachmentCondenser } from "@/lib/agent/documentExtraction";
import { ensureStoredExtract } from "@/lib/agent/documentExtractionStore";
import { prepareEmbeddedSourceDocument } from "@/lib/agent/sourceDocuments";
import { loadAssetsByIds } from "@/lib/db/mediaAssets";
import { EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import { downloadAssetBytes } from "@/lib/storage/media";
import {
	MAX_IMAGE_BYTES,
	type SourceMaterialDeps,
	SourceMaterialError,
} from "./sources";

/** Production seams. The condenser backs the extraction store's backstop
 *  for a document whose eager extraction never ran. */
export function productionSourceMaterialDeps(
	condenser: AttachmentCondenser,
	runtime?: {
		readonly authorize: () => Promise<unknown>;
		readonly signal?: AbortSignal;
	},
): SourceMaterialDeps {
	// A failed automatic read is not an invitation to bill the same failing
	// extraction on every tool retry. The next run gets a fresh attempt; a
	// separately published ready extract can still replace a failure here.
	const attempts = new Map<
		string,
		{
			extractedAt: number | undefined;
			promise: ReturnType<NonNullable<SourceMaterialDeps["prepareDocument"]>>;
		}
	>();
	const prepareDocument: NonNullable<SourceMaterialDeps["prepareDocument"]> = (
		asset,
		kind,
		signal,
		onProgress,
	) => {
		const key = `${asset.id}:${asset.contentHash}:${EXTRACTOR_VERSION}`;
		const previous = attempts.get(key);
		if (
			previous &&
			!(
				asset.extract?.status === "ready" &&
				asset.extract.version >= EXTRACTOR_VERSION &&
				asset.extract.extractedAt !== previous.extractedAt
			)
		)
			return previous.promise;
		const signals = [runtime?.signal, signal].filter(
			(value): value is AbortSignal => value !== undefined,
		);
		const preparationSignal = signals.length
			? AbortSignal.any(signals)
			: undefined;
		const preparation = runtime
			? prepareEmbeddedSourceDocument({
					asset,
					documentKind: kind,
					condenser,
					authorize: runtime.authorize,
					signal: preparationSignal,
					onProgress,
				})
			: ensureStoredExtract({
					asset,
					documentKind: kind,
					condenser,
					onInflight: "wait",
					signal: preparationSignal,
					onProgress,
				});
		const promise = preparation.then((result) => {
			if (result.status === "ready" && attempts.get(key)?.promise === promise)
				attempts.delete(key);
			return result;
		});
		attempts.set(key, { extractedAt: asset.extract?.extractedAt, promise });
		return promise;
	};
	return {
		prepareDocument,
		loadAssets: (ids, projectId) => loadAssetsByIds(ids, projectId),
		async readExtract(asset, kind) {
			const result = await prepareDocument(asset, kind, runtime?.signal);
			if (result.status === "ready") {
				return {
					text: result.text,
					truncated: result.truncated,
					version: result.version,
				};
			}
			throw new SourceMaterialError(
				`The document "${asset.originalFilename}" could not be read: its preparation failed, so its requirements cannot ground a design. Retry preparation in the Library or choose another source. The uploaded file is still saved.`,
			);
		},
		async loadImage(asset) {
			const bytes = await downloadAssetBytes(
				asset.gcsObjectKey,
				MAX_IMAGE_BYTES,
				runtime?.signal,
			);
			return {
				mediaType: asset.mimeType,
				dataUrl: `data:${asset.mimeType};base64,${bytes.toString("base64")}`,
				bytesDigest: createHash("sha256").update(bytes).digest("hex"),
			};
		},
	};
}
