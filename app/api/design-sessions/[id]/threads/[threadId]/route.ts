/**
 * One pre-app design-session thread, transcript included.
 *
 * GET /api/design-sessions/{id}/threads/{threadId}
 *
 * This is the post-resume heal boundary for `/build/new?design=...`. The
 * shared generation-target resolver preserves the owner-private pre-app
 * boundary and transparently follows the session after materialization. The
 * returned app id lets a refresh race leave the app-less shell and hydrate
 * the canonical Blueprint from its normal page.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { resolveGenerationTargetScope } from "@/lib/db/generationTargetScope";
import { loadThread } from "@/lib/db/threads";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string; threadId: string }> },
) {
	try {
		const session = await requireSession(req);
		const { id, threadId } = await params;
		const target = { kind: "design-session", designSessionId: id } as const;
		await resolveGenerationTargetScope(target, session.user.id, "view");
		const thread = await loadThread(target, threadId, session.user.id);
		if (!thread) throw new ApiError("Thread not found", 404);
		/* Materialization can race the transcript read. Resolve again afterward so
		 * the response cannot reuse a pre-app projection that was already stale
		 * when the thread finished loading. The shared resolver repeats the same
		 * opaque authorization boundary while surfacing the newly bound app. */
		const latestScope = await resolveGenerationTargetScope(
			target,
			session.user.id,
			"view",
		);
		return Response.json(
			{ thread, materializedAppId: latestScope.appId },
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (err) {
		const response = handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load thread", 500),
		);
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	}
}
