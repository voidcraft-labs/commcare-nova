/**
 * GET /api/apps — list the authenticated user's apps.
 *
 * Returns denormalized app summaries (no full blueprints) sorted by
 * last modified. Requires authentication.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { listApps } from "@/lib/db/apps";

export async function GET(req: Request) {
	try {
		const session = await requireSession(req);
		const apps = await listApps(session.user.id);
		return Response.json({ apps });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load apps", 500),
		);
	}
}
