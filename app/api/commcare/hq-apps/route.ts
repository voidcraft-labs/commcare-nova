/**
 * The bring-in picker's list of one project space's apps, each with who
 * already holds it in Nova.
 *
 * A stop is an answer, so it is 200 with the stop in the body; only a query
 * that names no project space is refused. It is a route and not a Server
 * Action because Next dispatches a client's actions one at a time, and a read
 * of CommCare HQ that takes seconds would hold every other action of the tab
 * behind it. It is one person's answer, so no cache keeps it.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { isValidDomainSlug } from "@/lib/commcare/client";
import { listHqAppsForPicker } from "@/lib/deployment/reading";
import { READING_REFUSAL_STATUS } from "@/lib/deployment/reading/types";
import { READING_REFUSAL_COPY } from "@/lib/publish/hqReadingCopy";

const NOT_STORED = { "Cache-Control": "private, no-store" };

export async function GET(req: Request) {
	try {
		const session = await requireSession(req);
		const domain = new URL(req.url).searchParams.get("domain");
		if (domain === null || !isValidDomainSlug(domain)) {
			return Response.json(
				{ error: READING_REFUSAL_COPY.invalid_input, code: "invalid_input" },
				{ status: READING_REFUSAL_STATUS.invalid_input, headers: NOT_STORED },
			);
		}
		const picker = await listHqAppsForPicker(
			{ userId: session.user.id },
			{ domain },
		);
		return Response.json({ picker }, { headers: NOT_STORED });
	} catch (err) {
		const response = handleApiError(
			err instanceof Error
				? err
				: new ApiError("Nova couldn't list this project space's apps", 500),
		);
		response.headers.set("Cache-Control", NOT_STORED["Cache-Control"]);
		return response;
	}
}
