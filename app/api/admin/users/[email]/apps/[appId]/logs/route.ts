/**
 * Admin log replay endpoint — load generation logs for any user's app.
 *
 * GET /api/admin/users/{email}/apps/{appId}/logs
 * GET /api/admin/users/{email}/apps/{appId}/logs?runId={id}
 *
 * Mirrors the user-facing logs endpoint but scopes to the target user's email
 * (from URL path) instead of the session user's email. Admin-only access.
 * Returns `{ events: StoredEvent[], runId: string | null }`.
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
		const { email: rawEmail, appId } = await params;
		const email = decodeURIComponent(rawEmail);
		const { searchParams } = new URL(req.url);

		const runId =
			searchParams.get("runId") ?? (await loadLatestRunId(email, appId));
		if (!runId) return Response.json({ events: [], runId: null });

		const events = await loadRunEvents(email, appId, runId);
		return Response.json({ events, runId });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load logs", 500),
		);
	}
}
