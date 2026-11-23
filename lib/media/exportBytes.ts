import "server-only";
import { createHash } from "node:crypto";
import { getStoredObjectMetadata, streamAsset } from "@/lib/storage/media";

/** The object key comes only from a Project-scoped ready media row. Digest and
 * length must both match the exact authored file before its archive is released. */
export function projectMediaByteSource(
	key: string,
	length: number,
	sha256: string,
) {
	let generation: Promise<string> | undefined;
	return {
		size: length,
		async *open() {
			generation ??= getStoredObjectMetadata(key).then((metadata) => {
				if (!metadata || metadata.size !== length)
					throw new Error(
						"The stored media does not match its Project record.",
					);
				return metadata.generation;
			});
			yield* checkedMediaBytes(key, await generation, length, sha256);
		},
	};
}

async function* checkedMediaBytes(
	key: string,
	generation: string,
	length: number,
	sha256: string,
) {
	const input = streamAsset(key, generation);
	const hash = createHash("sha256");
	let actual = 0;
	try {
		for await (const piece of input) {
			if (!(piece instanceof Uint8Array) || piece.length > length - actual)
				throw new Error("The media file changed while preparing the download.");
			actual += piece.length;
			hash.update(piece);
			yield piece;
		}
		if (actual !== length || hash.digest("hex") !== sha256)
			throw new Error("The stored media does not match its Project record.");
	} finally {
		input.destroy();
	}
}
