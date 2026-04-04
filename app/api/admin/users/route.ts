/**
 * Admin user list endpoint — returns all users with current month usage.
 *
 * GET /api/admin/users → { users: AdminUserRow[], stats: AdminStats }
 *
 * Data fetching is delegated to getAdminUsersWithStats() in lib/db/admin.ts,
 * shared with the RSC admin dashboard page. This route is retained for
 * external API consumers — the RSC page calls the DB function directly.
 */
import { requireAdmin } from "@/lib/auth-utils";
import { ApiError, handleApiError } from "@/lib/apiError";
import { getAdminUsersWithStats } from "@/lib/db/admin";

export async function GET(req: Request) {
	try {
		await requireAdmin(req);
		const response = await getAdminUsersWithStats();
		return Response.json(response);
	} catch (err) {
		return handleApiError(
			err instanceof Error
				? err
				: new ApiError("Failed to load admin data", 500),
		);
	}
}
