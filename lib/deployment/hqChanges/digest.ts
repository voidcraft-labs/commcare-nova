/**
 * The digest of a review of the changes made in CommCare HQ: one SHA-256
 * over what decides the lists the person was shown. The review answers it;
 * the bring-in computes it again from its own reads and acts only where the
 * two are equal, so it asks for no second statement that the person saw the
 * lists: a list that grew between the review and the press moved the head,
 * the baseline or CommCare HQ's source, and the digest with it.
 *
 * It never sees a media asset id of a file read from CommCare HQ, which is
 * not stable between the two requests (a review names a file by a
 * provisional id, a bring-in by the asset it published): the document comes
 * keyed by each such file's content (`reading/mediaIds.ts::reviewMediaId`),
 * as a bring-in's own digest keys it.
 */

import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { BlueprintDoc } from "@/lib/domain";
import { remapAssetRefs } from "@/lib/domain/mediaRefs";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { AdoptedMediaFile } from "../adoption";
import type { HqMediaPath, HqMediaRecord } from "../hqMedia";
import type { appConfirmationScope } from "../hqSourceBaseline";
import { reviewMediaId } from "../reading/mediaIds";
import type {
	ReviewOwnerRule,
	ReviewTable,
} from "../reading/projectData/reviewTypes";
import {
	canonicalTargetIdentity,
	type TargetIdentity,
} from "../targetIdentity";

export interface HqChangesDigestInput {
	readonly identity: {
		readonly read: TargetIdentity;
		readonly next: TargetIdentity;
	};
	/** The reviewed mapping and its continuous claim of this HQ app. */
	readonly authority: ReturnType<typeof appConfirmationScope>;
	/** The stored baseline's `source_digest`: the source the base reading read. */
	readonly baselineDigest: string;
	readonly approvedRemovals?: readonly string[];
	readonly removedFiles?: readonly string[];
	readonly requiredReview?:
		| "historical-first-publish"
		| "new-unused-files"
		| "changed-publish-subjects";
	/** The digest of CommCare HQ's whole normalized source as this request read it. */
	readonly sourceDigest: string;
	/** The app's head sequence the plan was computed at. */
	readonly headSeq: number;
	/** The exact destination, principal and profile changes the explicit review will record. */
	readonly installationReview?: {
		readonly app: string;
		readonly actor: string;
		readonly project: string;
		readonly server: string;
		readonly domain: string;
		readonly remoteApp: string;
		readonly workingVersion: number;
		readonly mapping: string;
		readonly deployment: string;
		readonly endings: number;
		readonly changes: readonly import("../targetIdentity").InstallationReviewChange[];
	};
	/** Every path the reference publishes, settled against the source now. */
	readonly media: readonly HqMediaPath[];
	/** Baseline file ids at the paths whose meaning the decision used. */
	readonly recordedFiles: HqMediaRecord | null;
	readonly incomingPaths: readonly string[];
	/** `contentNamedDocument` of the document the app takes, where the review lists changes. */
	readonly target: string | null;
	/**
	 * The review entries of the tables the changed app newly reads: what
	 * CommCare HQ holds of each (its content's digest) and the Project table
	 * it meets, at the revisions read. A bring-in creates or adopts exactly
	 * these, so one that changed since the review is asked about again.
	 */
	readonly tables: readonly ReviewTable[];
	/** The owner rules the changed app gives cases by that the places cannot satisfy. */
	readonly ownerRules: readonly ReviewOwnerRule[];
}

/**
 * `canonicalJsonDigest` of the input, rebuilt from its own fields: 64
 * lower-case hex characters. Each path is reduced to what CommCare HQ holds
 * there and how it stands, in the order the reference publishes them.
 */
export function hqChangesReviewDigest(input: HqChangesDigestInput): string {
	return canonicalJsonDigest({
		v: 4,
		...(input.approvedRemovals?.length
			? { approvedRemovals: input.approvedRemovals }
			: {}),
		...(input.removedFiles?.length ? { removedFiles: input.removedFiles } : {}),
		...(input.requiredReview && { requiredReview: input.requiredReview }),
		identity: {
			read: canonicalTargetIdentity(input.identity.read),
			next: canonicalTargetIdentity(input.identity.next),
		},
		authority: input.authority,
		baselineDigest: input.baselineDigest,
		sourceDigest: input.sourceDigest,
		headSeq: input.headSeq,
		...(input.installationReview && {
			installationReview: input.installationReview,
		}),
		media: [...input.media]
			.sort((a, b) =>
				a.wirePath < b.wirePath ? -1 : a.wirePath > b.wirePath ? 1 : 0,
			)
			.map((path) => ({
				wirePath: path.wirePath,
				contentHash: path.contentHash,
				standing: path.standing,
				hq: path.hq,
			})),
		recordedFiles: [
			...new Set([
				...input.media.map((file) => file.wirePath),
				...input.incomingPaths,
			]),
		]
			.sort()
			.map((path) => [
				path,
				input.recordedFiles && Object.hasOwn(input.recordedFiles, path)
					? input.recordedFiles[path]
					: null,
			]),
		target: input.target,
		tables: input.tables,
		...(input.ownerRules.length > 0 && { ownerRules: input.ownerRules }),
	});
}

/**
 * `canonicalJsonDigest` of the persistable document with every file read
 * from CommCare HQ named by its content: each of `files`' assets, whether a
 * provisional id or a published asset, becomes `reviewMediaId(contentHash)`,
 * and so does each of the Project's own assets the document shows whose
 * content (`ownContent`, by asset id) is one of those files'. A bring-in
 * publishes a file the Project already holds the bytes of as that asset, so
 * an own asset of the same content is the file in one request and not in the
 * other unless both name it by content. Every other asset of Nova's keeps its
 * id, which both requests read alike.
 */
export function contentNamedDocument(
	doc: BlueprintDoc,
	files: readonly Pick<AdoptedMediaFile, "assetId" | "contentHash">[],
	ownContent: ReadonlyMap<MediaAssetId, string>,
): string {
	return canonicalJsonDigest(
		remapAssetRefs(toPersistableDoc(doc), reviewAssetNames(files, ownContent)),
	);
}

/** Every asset carrying content shared with an incoming file gets the same
 * stable name before the document or its target paths are compared. */
export function reviewAssetNames(
	files: readonly Pick<AdoptedMediaFile, "assetId" | "contentHash">[],
	ownContent: ReadonlyMap<MediaAssetId, string>,
): ReadonlyMap<MediaAssetId, MediaAssetId> {
	const byContent = new Map<MediaAssetId, MediaAssetId>(
		files.map((file) => [file.assetId, reviewMediaId(file.contentHash)]),
	);
	const read = new Set(files.map((file) => file.contentHash));
	for (const [assetId, contentHash] of ownContent)
		if (read.has(contentHash) && !byContent.has(assetId))
			byContent.set(assetId, reviewMediaId(contentHash));
	return byContent;
}
