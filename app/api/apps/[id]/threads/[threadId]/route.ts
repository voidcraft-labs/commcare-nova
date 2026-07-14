/**
 * One chat thread, transcript included — what the client fetches when the
 * user opens a thread from the list.
 *
 * GET /api/apps/{id}/threads/{threadId}
 *
 * Requires an authenticated session and Project membership (view) on the
 * app; the thread read itself is app-scoped, so a thread id under a
 * different app is a 404 even for a member.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { resolveAppScope } from "@/lib/db/appAccess";
import { loadThread } from "@/lib/db/threads";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string; threadId: string }> },
) {
	try {
		const session = await requireSession(req);
		const { id, threadId } = await params;

		await resolveAppScope(id, session.user.id, "view");

		const thread = await loadThread(id, threadId);
		if (!thread) throw new ApiError("Thread not found", 404);
		return Response.json({ thread });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load thread", 500),
		);
	}
}
