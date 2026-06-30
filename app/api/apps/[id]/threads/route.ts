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
import { resolveAppScope } from "@/lib/db/appAccess";
import { loadThreads } from "@/lib/db/threads";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await requireSession(req);
		const { id } = await params;

		/* Project-membership gate (view) — threads are a subcollection of the app
		 * but the path alone doesn't scope access. An `AppAccessError` maps to 404
		 * in `handleApiError` (shared IDOR-safe not-found posture). */
		await resolveAppScope(id, session.user.id, "view");

		const threads = await loadThreads(id);
		return Response.json({ threads });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load threads", 500),
		);
	}
}
