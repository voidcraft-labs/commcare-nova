/**
 * What the first publish over an app brought in from CommCare HQ hands the
 * emitter, worked out from the reading alone: the tables and files it names
 * exist in Nova only once the app is born, so nothing here reads a store.
 * The birth's baseline is computed over the body this gives, which is the
 * body the first publish sends.
 */

import {
	type LookupWireNaming,
	lookupWireNaming,
} from "@/lib/commcare/lookup/naming";
import {
	type AssetManifest,
	type ResolvedMediaAsset,
	wirePathFor,
} from "@/lib/commcare/multimedia/assetWirePath";
import type { BlueprintDoc } from "@/lib/domain";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";
import type { PreparedExportBoundary } from "@/lib/export/boundaryValidation";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import { type AdoptedMediaFile, assignMediaPaths } from "../adoption";
import { reviewMediaId } from "./mediaIds";

/** Two native file ids can carry the same bytes. Review the wire paths
 * the Project's content deduplication will keep when it creates the app. */
export function readingMediaPaths(files: readonly AdoptedMediaFile[]) {
	return assignMediaPaths(
		files.map((file) => ({
			...file,
			assetId: reviewMediaId(file.contentHash),
		})),
	);
}

/** What `expandDoc` reads of an asset is its path, so a file's type is not told apart. */
const UNREAD_MIME_TYPE = "application/octet-stream";

/**
 * The export boundary of the first publish over an adopted app: the document
 * as given; the project space it came from as the attachment target; each
 * bound table under the tag and field names CommCare HQ holds, absent where
 * the document's reading bound none; and one resolved asset per file the
 * document references, at the path `assignMediaPaths` keeps for it (its
 * derivation where every path it had is dropped), with the file's own content
 * hash and extension, the kind of the slot that references it, and no bytes.
 * A file no slot of the document references is in no publish's manifest, so
 * it has none here.
 */
export function adoptionExportBoundary(
	doc: BlueprintDoc,
	lookupDefinitions: readonly LookupTableDefinition[],
	mediaFiles: readonly AdoptedMediaFile[],
	target: { readonly origin: string; readonly domain: string },
): Pick<
	PreparedExportBoundary,
	"doc" | "assets" | "attachmentTarget" | "lookupNaming"
> {
	const kept = new Map(
		readingMediaPaths(mediaFiles).rows.map((row) => [
			row.assetId,
			row.wirePath,
		]),
	);
	const files = new Map(mediaFiles.map((file) => [file.assetId, file]));
	const assets = new Map<string, ResolvedMediaAsset>();
	for (const ref of walkAssetRefs(doc)) {
		const file = files.get(ref.assetId as AdoptedMediaFile["assetId"]);
		if (file === undefined || assets.has(file.assetId)) continue;
		assets.set(file.assetId, {
			assetId: file.assetId,
			wirePath:
				kept.get(reviewMediaId(file.contentHash)) ??
				wirePathFor(file.contentHash, file.extension),
			kind: ref.slotKind,
			mimeType: UNREAD_MIME_TYPE,
			contentHash: file.contentHash,
			extension: file.extension,
		});
	}
	const naming: LookupWireNaming | undefined =
		lookupDefinitions.length === 0
			? undefined
			: lookupWireNaming(lookupDefinitions);
	return {
		doc,
		assets: assets as AssetManifest,
		attachmentTarget: { origin: target.origin, domain: target.domain },
		...(naming !== undefined && { lookupNaming: naming }),
	};
}
