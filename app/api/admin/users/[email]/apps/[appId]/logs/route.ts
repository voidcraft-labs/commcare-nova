/**
 * Admin log replay endpoint — load generation logs for any user's app.
 *
 * GET /api/admin/users/{email}/apps/{appId}/logs
 * GET /api/admin/users/{email}/apps/{appId}/logs?runId={id}
 *
 * The email URL segment is retained for admin navigation context but is no
 * longer used for Firestore access — logs are read directly by appId from
 * the root-level `apps/{appId}/logs/` subcollection.
 *
 * Admin-only access. Returns `{ events: StoredEvent[], runId: string | null }`.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireAdmin } from "@/lib/auth-utils";
import { loadLatestRunId, loadRunEvents } from "@/lib/db/logs";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ email: string; appId: string }> },
) {
	try {
		await requireAdmin(req);
		const { appId } = await params;
		const { searchParams } = new URL(req.url);

		const runId = searchParams.get("runId") ?? (await loadLatestRunId(appId));
		if (!runId) return Response.json({ events: [], runId: null });

		const events = await loadRunEvents(appId, runId);
		return Response.json({ events, runId });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load logs", 500),
		);
	}
}
