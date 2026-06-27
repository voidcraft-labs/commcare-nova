/**
 * Chat threads API — load conversation history for an app.
 *
 * GET /api/apps/{id}/threads — returns all threads ordered chronologically.
 *
 * Requires an authenticated session and Project membership (view) on the app,
 * via `resolveAppScope`.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { loadThreads } from "@/lib/db/threads";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await requireSession(req);
		const { id } = await params;

		/* Project-membership gate (view) — threads are a subcollection of the app
		 * but the path alone doesn't scope access; without this a crafted request
		 * could read another Project's conversation history. */
		try {
			await resolveAppScope(id, session.user.id, "view");
		} catch (err) {
			if (err instanceof AppAccessError)
				throw new ApiError("App not found", 404);
			throw err;
		}

		const threads = await loadThreads(id);
		return Response.json({ threads });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load threads", 500),
		);
	}
}
