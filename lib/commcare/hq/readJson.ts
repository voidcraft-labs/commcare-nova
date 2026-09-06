import "server-only";

import { log } from "@/lib/logger";
import { withHqRequestDeadline } from "./deadline";
import {
	authHeader,
	type CommCareApiError,
	type CommCareCredentials,
	warnAndReturnError,
} from "./http";

/** A response from the exact selected endpoint, never from a redirect target.
 * Validation of the returned JSON belongs to its wire consumer. */
export async function readHqJson(
	creds: CommCareCredentials,
	url: string,
	label: string,
	signal?: AbortSignal,
): Promise<{ readonly data: unknown } | CommCareApiError> {
	if (signal === undefined)
		return withHqRequestDeadline((owned) =>
			readHqJson(creds, url, label, owned),
		);
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { Authorization: authHeader(creds), Accept: "application/json" },
			redirect: "manual",
			cache: "no-store",
			signal,
		});
	} catch (error) {
		log.warn(`[commcare] ${label} unavailable`, { error });
		return { success: false, status: 503 };
	}
	if (!response.ok) return warnAndReturnError(`${label} refused`, response);
	try {
		return { data: await response.json() };
	} catch {
		return { success: false, status: signal.aborted ? 503 : 502 };
	}
}
