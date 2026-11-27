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
 * When a declaration would remove physical HQ file references, the receipt
 * includes their paths and file IDs, the normalized source and its working
 * save counter. Otherwise a save that changes none of the reviewed values
 * can proceed. Birth records the current file IDs at retained paths.
 */

import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { TargetIdentity } from "../targetIdentity";
import type { ReadingKey, ReadingReview } from "./types";

export interface ReviewDigestInput {
	readonly v: 3;
	readonly authority: ReadingKey & {
		readonly appId: string;
		readonly user: string | null;
		readonly role: string | null;
	};
	readonly source?: { readonly revision: number; readonly digest: string };
	/** Each declaration’s source inputs to the registered publish changes, when present. */
	readonly publishInputs?: string;
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
		authority: input.authority,
		...(input.source && { source: input.source }),
		...(input.publishInputs && { publishInputs: input.publishInputs }),
		review,
		document: input.document,
		targetIdentity: input.targetIdentity,
	});
}
