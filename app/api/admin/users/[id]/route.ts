/**
 * Admin user detail endpoint — returns a single user's profile, usage history, and apps.
 *
 * GET /api/admin/users/{userId} → AdminUserDetailResponse
 *
 * Data fetching is delegated to getAdminUserDetail() in lib/db/admin.ts,
 * shared with the RSC admin user detail page. This route is retained for
 * external API consumers — the RSC page calls the DB function directly.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireAdmin } from "@/lib/auth-utils";
import { getAdminUserDetail } from "@/lib/db/admin";

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	try {
		await requireAdmin(req);
		const { id: userId } = await params;

		const response = await getAdminUserDetail(userId);
		if (!response) {
			throw new ApiError("User not found", 404);
		}

		return Response.json(response);
	} catch (err) {
		return handleApiError(
			err instanceof Error
				? err
				: new ApiError("Failed to load user details", 500),
		);
	}
}
