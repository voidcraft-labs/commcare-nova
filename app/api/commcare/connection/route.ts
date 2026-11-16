/**
 * The signed-in person's own CommCare HQ connection, as Nova stores it.
 *
 * The builder's connection context reads it again when a person presses
 * Check connection, so a key added in Settings in another tab reaches the
 * open page without the Next router: a router refresh writes Next's own
 * address back over one the History API wrote.
 *
 * It reads Nova's own row and asks CommCare HQ nothing. The body is
 * `CommCareSettingsPublic`, the same value the page receives as a prop, so
 * it never holds the key. It is one person's answer, so no cache keeps it.
 */

import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { getCommCareSettings } from "@/lib/db/settings";

const NOT_STORED = { "Cache-Control": "private, no-store" };

export async function GET(req: Request) {
	try {
		const session = await requireSession(req);
		const connection = await getCommCareSettings(session.user.id);
		return Response.json({ connection }, { headers: NOT_STORED });
	} catch (err) {
		const response = handleApiError(
			err instanceof Error
				? err
				: new ApiError("Nova couldn't read your CommCare HQ connection", 500),
		);
		response.headers.set("Cache-Control", NOT_STORED["Cache-Control"]);
		return response;
	}
}
