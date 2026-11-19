/**
 * Review the changes made in CommCare HQ to one app Nova publishes there:
 * POST /api/commcare/changes/review.
 *
 * A thin shell over `reviewHqChanges`, answering in the shape both changes
 * routes share (`../respond.ts`): refusals before the stream as JSON with a
 * status, then a stream of the review's four stages and its file counts
 * ending in one `done` line with the review, whatever it found, or one
 * `failed` line. A review writes nothing. It is handed the request's own
 * signal as `cancel`, so a panel that closes stops the read at its next
 * call to CommCare HQ.
 *
 * A route and not a Server Action: Next dispatches a tab's actions one at a
 * time, and a review that waits on CommCare HQ would hold every other action
 * of the tab behind it, and could carry no stage as it moved.
 */

import { reviewHqChanges } from "@/lib/deployment/hqChanges";
import { answerHqChanges, hqChangesKeySchema } from "../respond";

export async function POST(req: Request): Promise<Response> {
	return answerHqChanges(req, {
		operation: "review",
		schema: hqChangesKeySchema,
		run: (scope, target, _key, onEvent) =>
			reviewHqChanges(scope, target, { onEvent, cancel: req.signal }),
	});
}
