/**
 * GET /api/user/usage — current month's credit summary for the authenticated user.
 *
 * Returns the full credit picture: how many credits the user has been granted
 * this month (allowance + any admin bonus), how many they have spent (consumed),
 * what they have left (balance), and their total spend across all time
 * (lifetimeConsumed). The client uses this to render a usage bar and balance
 * display without knowing any internal dollar amounts.
 * Authenticated-only.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { getCreditSummary } from "@/lib/db/credits";

export async function GET(req: Request) {
	try {
		const session = await requireSession(req);
		return Response.json(await getCreditSummary(session.user.id));
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load usage", 500),
		);
	}
}
