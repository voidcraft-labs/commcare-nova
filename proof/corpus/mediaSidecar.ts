import type {
	CapturedMediaUpload,
	CapturedRequest,
	SaveCounterMove,
} from "./publish";

/** The first physical request retains its historical name in the input manifest. */
export function mediaRole(index: number) {
	return index === 0 ? "media" : `media-${index + 1}`;
}

/** Preserve the single-upload layout of historical records. A multi-batch
 * import names every body in send order with its own observed save counter. */
export async function writeMediaSidecar(
	uploads: readonly CapturedMediaUpload[],
	write: (request: CapturedRequest, role: string) => Promise<string>,
) {
	const mediaBatches: { body: string; saveCounter: SaveCounterMove }[] = [];
	for (const [index, upload] of uploads.entries()) {
		mediaBatches.push({
			body: await write(upload.request, mediaRole(index)),
			saveCounter: upload.saveCounter,
		});
	}
	const first = mediaBatches[0];
	if (!first) return {};
	if (mediaBatches.length === 1)
		return { media: first.body, mediaSaveCounter: first.saveCounter };
	return { mediaBatches };
}
