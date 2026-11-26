/**
 * Bring in the changes made in CommCare HQ that a person reviewed:
 * POST /api/commcare/changes/bring-in.
 *
 * A thin shell over `bringInHqChanges`, answering in the shape both changes
 * routes share (`../respond.ts`): refusals before the stream as JSON with a
 * status, then a stream of the review's four stages, then adding the files
 * to the Project and the bring-in itself, ending in one `done` line with
 * what the bring-in answered, whatever it was, or one `failed` line.
 *
 * It is handed no signal: once a person has chosen to bring the changes in,
 * the work runs to its end whether or not the tab is still there to read the
 * stream. A bring-in sent again with the same body answers the commit the
 * first one made, or the review as it now stands.
 */

import { bringInHqChanges } from "@/lib/deployment/hqChanges";
import { answerHqChanges, hqChangesBringInSchema } from "../respond";

export async function POST(req: Request): Promise<Response> {
	return answerHqChanges(req, {
		operation: "bring-in",
		schema: hqChangesBringInSchema,
		run: (scope, target, body, onEvent) =>
			bringInHqChanges(
				scope,
				target,
				{
					readingId: body.readingId,
					reviewDigest: body.reviewDigest,
					tableChoices: body.tableChoices,
					ownerRuleChoices: body.ownerRuleChoices,
				},
				{ onEvent },
			),
	});
}
