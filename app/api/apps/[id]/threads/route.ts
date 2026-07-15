/**
 * Chat threads API — the conversation list for an app.
 *
 * GET /api/apps/{id}/threads — thread METAS (no transcripts), most recently
 * active first. The thread switcher's list read; full transcripts load per
 * thread via `/api/apps/{id}/threads/{threadId}`.
 *
 * Requires an authenticated session and Project membership (view) on the app,
 * via `resolveAppScope`.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { resolveAppScope } from "@/lib/db/appAccess";
import { listThreadMetas } from "@/lib/db/threads";

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

		const threads = await listThreadMetas(id);
		return Response.json({ threads });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load threads", 500),
		);
	}
}
