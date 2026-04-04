/**
 * GET /api/user/usage — current month's usage for the authenticated user.
 *
 * Returns the cost estimate, request count, spend cap, and period string
 * so the client can render a usage bar without knowing the cap value.
 * Authenticated-only.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import {
	getCurrentPeriod,
	getMonthlyUsage,
	MONTHLY_SPEND_CAP_USD,
} from "@/lib/db/usage";

export async function GET(req: Request) {
	try {
		const session = await requireSession(req);
		const usage = await getMonthlyUsage(session.user.email);
		return Response.json({
			cost_estimate: usage?.cost_estimate ?? 0,
			request_count: usage?.request_count ?? 0,
			cap: MONTHLY_SPEND_CAP_USD,
			period: getCurrentPeriod(),
		});
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new ApiError("Failed to load usage", 500),
		);
	}
}
