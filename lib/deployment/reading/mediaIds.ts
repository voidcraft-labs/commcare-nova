/**
 * The ids a reading of a CommCare HQ app gives its media files.
 *
 * A file's asset id is not stable across a reading and the create that
 * follows it. Before any asset exists, the reading names each file by
 * `provisionalReadingMediaId`, which never reaches storage; after the create
 * publishes it, the file is the published asset, which may be one the Project
 * already held. So whatever compares the two moments keys each file by its
 * content instead, through `reviewMediaId`.
 */

import { v5 as uuidv5 } from "uuid";
import type { HqMediaType } from "@/lib/commcare/hq/appSource";
import { asMediaAssetId, type MediaAssetId } from "@/lib/domain/multimedia";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";

export const READING_MEDIA_NAMESPACE = "4374916f-4ced-42c6-b00d-f7fb7b45aaaf";

/** UUIDv5 under `READING_MEDIA_NAMESPACE` of
 *  `canonicalJsonText([appId, mediaType, multimediaId])`. */
export function provisionalReadingMediaId(
	appId: string,
	mediaType: HqMediaType,
	multimediaId: string,
): MediaAssetId {
	return asMediaAssetId(
		uuidv5(
			canonicalJsonText([appId, mediaType, multimediaId]),
			READING_MEDIA_NAMESPACE,
		),
	);
}

/** UUIDv5 under the same namespace of `canonicalJsonText(["content",
 *  contentHash])`: one id per file content. `contentHash` is the SHA-256 a
 *  held file's verdict carries. */
export function reviewMediaId(contentHash: string): MediaAssetId {
	return asMediaAssetId(
		uuidv5(
			canonicalJsonText(["content", contentHash]),
			READING_MEDIA_NAMESPACE,
		),
	);
}
