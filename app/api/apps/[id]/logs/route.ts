/**
 * App logs API — load generation run logs from the events table.
 *
 * GET /api/apps/{id}/logs            — load entries for the latest run
 * GET /api/apps/{id}/logs?runId={id} — load entries for a specific run
 *
 * Both return `{ events: StoredEvent[], runId: string | null }`.
 * When no entries exist, returns `{ entries: [], runId: null }`.
 *
 * Admin-only — logs contain full conversation transcripts that may include
 * sensitive information. Regular users cannot access logs.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireAdmin } from "@/lib/auth-utils";
import { readEvents, readLatestRunId } from "@/lib/log/reader";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		await requireAdmin(req);
		const { id: appId } = await params;
		const { searchParams } = new URL(req.url);

		const runId = searchParams.get("runId") ?? (await readLatestRunId(appId));
		if (!runId) return Response.json({ events: [], runId: null });

		// `skipped` surfaces a partial stream (events dropped for schema drift)
		// so the forensic caller knows the log isn't complete.
		const { events, skipped } = await readEvents(appId, runId);
		return Response.json({ events, runId, skipped });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load logs", 500),
		);
	}
}
