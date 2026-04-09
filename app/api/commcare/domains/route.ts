/**
 * CommCare HQ domain listing — GET /api/commcare/domains.
 *
 * Returns the user's approved project spaces from the settings document.
 * The list is tested and stored when credentials are saved
 * (PUT /api/settings/commcare) — no live API call to CommCare HQ here.
 *
 * API key scope and domain slugs are both immutable in CommCare HQ,
 * so the stored list stays accurate.
 */

import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { getApprovedDomains } from "@/lib/db/settings";

export async function GET(req: NextRequest) {
	try {
		const session = await requireSession(req);
		const domains = await getApprovedDomains(session.user.id);

		if (!domains) {
			throw new ApiError(
				"CommCare HQ is not configured. Add your API key in Settings.",
				400,
			);
		}

		return NextResponse.json({ domains });
	} catch (err) {
		return handleApiError(
			err instanceof Error ? err : new Error("Failed to fetch domains"),
		);
	}
}
