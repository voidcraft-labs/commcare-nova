/**
 * Project logs API — load generation run logs from Firestore.
 *
 * GET /api/projects/{id}/logs            — load entries for the latest run
 * GET /api/projects/{id}/logs?runId={id} — load entries for a specific run
 *
 * Both return `{ events: StoredEvent[], runId: string | null }`.
 * When no entries exist, returns `{ entries: [], runId: null }`.
 *
 * Admin-only — logs contain full conversation transcripts that may include
 * sensitive information. Regular users cannot access logs. The admin's email
 * (from session) scopes queries to their own data; cross-user log access
 * uses the dedicated admin endpoint at /api/admin/users/[email]/projects/[id]/logs.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireAdmin } from "@/lib/auth-utils";
import { loadLatestRunId, loadRunEvents } from "@/lib/db/logs";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		const session = await requireAdmin(req);
		const { id: projectId } = await params;
		const { searchParams } = new URL(req.url);
		const email = session.user.email;

		const runId =
			searchParams.get("runId") ?? (await loadLatestRunId(email, projectId));
		if (!runId) return Response.json({ events: [], runId: null });

		const events = await loadRunEvents(email, projectId, runId);
		return Response.json({ events, runId });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load logs", 500),
		);
	}
}
