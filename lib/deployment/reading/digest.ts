/**
 * The digest of a bring-in's review: one SHA-256 over everything the person
 * was shown and everything the birth would write. The read answers it with
 * the review; the create computes it again from its own fresh read and goes
 * on only where the two are equal.
 *
 * It leaves out when the read ended, so the same app read a minute later has
 * the same digest, and it never sees a media asset id, which is not stable
 * between the two requests: the document and the media paths come keyed by
 * each file's content (`mediaIds.ts::reviewMediaId`).
 */

import type { DeploymentIdentityOverride } from "@/lib/deployment/types";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { MediaPathAssignment } from "../adoption";
import type { ReadingReview } from "./types";

export interface ReviewDigestInput {
	readonly v: 1;
	/** The review without `readAt`. */
	readonly review: Omit<ReadingReview, "readAt">;
	/** `canonicalJsonDigest` of the persistable document with every media asset id replaced. */
	readonly document: string;
	/** `adoptedIdentityRows(...)`, as written: kind, Nova UUID, HQ id, `xmlns`. */
	readonly identities: readonly DeploymentIdentityOverride[];
	/** `assignMediaPaths(...)` over the files with each `assetId` set to `reviewMediaId(contentHash)`. */
	readonly mediaPaths: MediaPathAssignment;
}

/**
 * `lib/utils/canonicalJson.ts::canonicalJsonDigest(input)`: 64 lower-case hex
 * characters. The input is rebuilt from its own fields first, so a whole
 * `ReadingReview` handed in as `review` still leaves its `readAt` out, and
 * nothing beyond the input's fields is digested.
 */
export function reviewDigestOf(input: ReviewDigestInput): string {
	const { readAt: _readAt, ...review } = input.review as ReadingReview;
	return canonicalJsonDigest({
		v: input.v,
		review,
		document: input.document,
		identities: input.identities,
		mediaPaths: input.mediaPaths,
	});
}
