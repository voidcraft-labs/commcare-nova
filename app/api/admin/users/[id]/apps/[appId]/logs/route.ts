/**
 * Admin log replay endpoint — load generation events for any user's app.
 *
 * GET /api/admin/users/{userId}/apps/{appId}/logs
 * GET /api/admin/users/{userId}/apps/{appId}/logs?runId={id}
 *
 * The userId URL segment is retained for admin navigation context but is
 * not used for Firestore access — events are read by appId from
 * `apps/{appId}/events/` via `readEvents`. Without `runId`,
 * `readLatestRunId` picks the most recent run.
 *
 * Admin-only access. Returns `{ events: Event[], runId: string | null }`.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireAdmin } from "@/lib/auth-utils";
import { readEvents, readLatestRunId } from "@/lib/log/reader";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string; appId: string }> },
) {
	try {
		await requireAdmin(req);
		const { appId } = await params;
		const { searchParams } = new URL(req.url);

		const runId = searchParams.get("runId") ?? (await readLatestRunId(appId));
		if (!runId) return Response.json({ events: [], runId: null });

		const events = await readEvents(appId, runId);
		return Response.json({ events, runId });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load logs", 500),
		);
	}
}
