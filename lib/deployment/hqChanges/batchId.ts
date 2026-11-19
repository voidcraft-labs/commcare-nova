/**
 * The batch id a bring-in of changes made in CommCare HQ commits under.
 *
 * Client-safe: the panel that sends the bring-in derives the same id before
 * it sends, so the reload its own commit causes is told apart from someone
 * else's.
 */

import { v5 as uuidv5 } from "uuid";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";

/** The namespace every bring-in of changes names its batch under. */
export const HQ_CHANGES_BATCH_NAMESPACE =
	"8a3c1f52-6d0e-4b97-9f2a-5c71e4d0b836";

/**
 * UUIDv5 under `HQ_CHANGES_BATCH_NAMESPACE` of
 * `canonicalJsonText([deploymentId, reviewDigest, memberId])`.
 *
 * Two requests of one member that carry one digest name one batch, so the
 * commit's `(app_id, batch_id)` latch answers the second with the first's
 * commit. The member is in the name because the latch compares the actor:
 * another member's request with the same digest is another batch, which the
 * head test answers.
 */
export function hqChangesBatchId(input: {
	readonly deploymentId: string;
	readonly reviewDigest: string;
	readonly memberId: string;
}): string {
	return uuidv5(
		canonicalJsonText([input.deploymentId, input.reviewDigest, input.memberId]),
		HQ_CHANGES_BATCH_NAMESPACE,
	);
}
