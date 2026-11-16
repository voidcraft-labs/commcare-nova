/**
 * Create the app a person reviewed from CommCare HQ:
 * POST /api/commcare/bring-in/create.
 *
 * A thin shell over `createFromReview`, answering in the shape both bring-in
 * routes share (`../respond.ts`): refusals before the stream as JSON with a
 * status, then a stream of the create's stages and file counts ending in one
 * `done` line with what the create answered, or one `failed` line. An app
 * created, a review that changed, a stop and a refusal of the person's
 * answers are all answers on that line, never statuses.
 *
 * The create is handed no signal: once a person has chosen to bring the app
 * in, the work runs to its end whether or not the tab is still there to read
 * the stream. A create sent again with the same body answers the app the
 * first one made.
 */

import { createFromReview } from "@/lib/deployment/reading";
import { broughtInAppId } from "@/lib/deployment/reading/appId";
import { bringInInputSchema } from "@/lib/deployment/reading/types";
import { answerBringIn } from "../respond";

export async function POST(req: Request): Promise<Response> {
	return answerBringIn(req, {
		operation: "create",
		schema: bringInInputSchema,
		appIdOf: (userId, input) => broughtInAppId(userId, input, input.readingId),
		run: (actor, input, onEvent) => createFromReview(actor, input, { onEvent }),
	});
}
