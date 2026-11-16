/**
 * Read one app of a CommCare HQ project space for review:
 * POST /api/commcare/bring-in/read.
 *
 * A thin shell over `readHqAppForReview`, answering in the shape both
 * bring-in routes share (`../respond.ts`): refusals before the stream as
 * JSON with a status, then a stream of the read's stages and file counts
 * ending in one `done` line with a stop, an account or a review, or one
 * `failed` line. A read writes nothing. It is handed the request's own
 * signal as `cancel`, so a tab that closes stops the read at its next call
 * to CommCare HQ.
 *
 * A route and not a Server Action: Next dispatches a client's actions one at
 * a time, and a read of an app with many files holds its request for a minute
 * or more, which as an action would hold every other action of the tab behind
 * it and could carry no count as it moved.
 */

import { readHqAppForReview } from "@/lib/deployment/reading";
import { readingKeySchema } from "@/lib/deployment/reading/types";
import { answerBringIn } from "../respond";

export async function POST(req: Request): Promise<Response> {
	return answerBringIn(req, {
		operation: "read",
		schema: readingKeySchema,
		/* The reading's id is minted inside the read, so the app's id is known only there. */
		appIdOf: () => null,
		run: (actor, key, onEvent) =>
			readHqAppForReview(actor, key, { onEvent, cancel: req.signal }),
	});
}
