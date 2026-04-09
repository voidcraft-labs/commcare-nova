/**
 * Chat threads API — load conversation history for an app.
 *
 * GET /api/apps/{id}/threads — returns all threads ordered chronologically.
 *
 * Requires an authenticated session. Ownership is verified explicitly —
 * the app's `owner` field must match `session.user.id`.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { loadAppOwner } from "@/lib/db/apps";
import { loadThreads } from "@/lib/db/threads";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await requireSession(req);
		const { id } = await params;

		/* Verify ownership — threads are a subcollection of the app, but the
		 * collection path alone doesn't scope access. Without this check, a
		 * crafted request could read another user's conversation history. */
		const owner = await loadAppOwner(id);
		if (!owner || owner !== session.user.id) {
			throw new ApiError("App not found", 404);
		}

		const threads = await loadThreads(id);
		return Response.json({ threads });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load threads", 500),
		);
	}
}
