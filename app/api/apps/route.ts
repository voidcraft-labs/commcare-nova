/**
 * GET /api/apps — list the authenticated user's apps.
 *
 * Returns denormalized app summaries (no full blueprints) sorted by
 * last modified. Requires authentication.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { listApps } from "@/lib/db/apps";

/**
 * Page size for the JSON API.
 *
 * The web app's landing page consumes this route and renders a single
 * card grid — same page size as `app/app-list.tsx`'s direct DB call so
 * the two surfaces stay in lockstep. When the UI introduces pagination
 * this constant and the route's response shape grow together.
 */
const JSON_LIST_PAGE_SIZE = 50;

export async function GET(req: Request) {
	try {
		const session = await requireSession(req);
		const { apps } = await listApps(session.user.id, {
			limit: JSON_LIST_PAGE_SIZE,
			sort: "updated_desc",
		});
		return Response.json({ apps });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load apps", 500),
		);
	}
}
