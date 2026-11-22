/**
 * The digest of a bring-in's review: one SHA-256 over everything the person
 * was shown and everything the birth would write. The read answers it with
 * the review; the create computes it again from its own fresh read and goes
 * on only where the two are equal.
 *
 * It leaves out when the read ended, so the same app read a minute later has
 * the same digest, and it never sees a media asset id, which is not stable
 * between the two requests: the document and the target-identity record come
 * keyed by each file's content (`mediaIds.ts::reviewMediaId`).
 *
 * It leaves out two things the birth writes, each because the review shows
 * nothing they change and the birth records CommCare HQ's state as it stands:
 * the baseline's stored source (a save that changes nothing Nova reads must
 * not send the person back) and its media-file record, the CommCare HQ
 * document at each held path (a file replaced in CommCare HQ under the same
 * path with the same bytes changes only that id, which the birth records as
 * it is).
 */

import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { TargetIdentity } from "../targetIdentity";
import type { ReadingKey, ReadingReview } from "./types";

export interface ReviewDigestInput {
	readonly v: 2;
	/** Exact source and authority for adopting the management of named installations. */
	readonly installationSource?: ReadingKey & {
		readonly appId: string;
		readonly actorUserId: string | null;
		readonly version: number;
		readonly digest: string;
	};
	/** The review without `readAt`. */
	readonly review: Omit<ReadingReview, "readAt">;
	/** `canonicalJsonDigest` of the persistable document with every media asset id replaced. */
	readonly document: string;
	/**
	 * The target-identity record the birth writes (the menu and form ids,
	 * each keyed create's case id prefix, each file's path), each file named
	 * by its content (`targetIdentity.ts::targetIdentityForDigest`).
	 */
	readonly targetIdentity: TargetIdentity;
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
		...(input.installationSource && {
			installationSource: input.installationSource,
		}),
		review,
		document: input.document,
		targetIdentity: input.targetIdentity,
	});
}
