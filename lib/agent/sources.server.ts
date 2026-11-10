import type { AttachmentCondenser } from "@/lib/agent/documentExtraction";
import { ensureStoredExtract } from "@/lib/agent/documentExtractionStore";
import { prepareEmbeddedSourceDocument } from "@/lib/agent/sourceDocuments";
import { EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import type { SourceMaterialDeps } from "./sources";

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
	return { prepareDocument };
}
