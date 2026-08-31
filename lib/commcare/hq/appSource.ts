import "server-only";

/**
 * Read the source document for an app Nova is about to update in place.
 *
 * CommCare HQ shallow-replaces every top-level field present in an import.
 * `profile` is one of those fields, so Nova may only send its derived profile
 * property after reading and preserving the complete target-owned bag. The
 * source endpoint is API-key authenticated and uses the same edit-apps gate as
 * import (`app_manager/views/apps.py::app_source`).
 */

import type { HqApplicationProfile } from "@/lib/commcare";
import { log } from "@/lib/logger";
import {
	authHeader,
	baseUrl,
	type CommCareApiError,
	type CommCareCredentials,
	INVALID_DOMAIN_SLUG,
	isValidDomainSlug,
	logAndReturnError,
	warnAndReturnError,
} from "./http";

export interface HqAppSourceProfile {
	readonly profile: HqApplicationProfile;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read only the profile bag the safe overlay needs.
 *
 * A missing or malformed bag is an unavailable source, never an empty profile:
 * treating it as empty would make the next import erase configuration that HQ
 * owns and Nova cannot reconstruct.
 */
export async function readHqAppSourceProfile(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
): Promise<HqAppSourceProfile | CommCareApiError> {
	if (!isValidDomainSlug(domain)) return INVALID_DOMAIN_SLUG;

	const url = `${baseUrl(creds)}/a/${domain}/apps/source/${encodeURIComponent(appId)}/`;
	let res: Response;
	try {
		res = await fetch(url, {
			headers: { Authorization: authHeader(creds) },
		});
	} catch (error) {
		log.warn("[commcare] app source unreachable", {
			domain,
			appId,
			error: error instanceof Error ? error.message : String(error),
		});
		return { success: false, status: 503 };
	}

	if (!res.ok) {
		return res.status === 401 || res.status === 403 || res.status === 404
			? warnAndReturnError("app source read refused", res)
			: logAndReturnError("app source read failed", res);
	}

	let source: unknown;
	try {
		source = await res.json();
	} catch {
		log.error("[commcare] app source returned non-JSON", undefined, {
			domain,
			appId,
		});
		return { success: false, status: 502 };
	}

	if (!isRecord(source) || !isRecord(source.profile)) {
		log.error("[commcare] app source profile is malformed", undefined, {
			domain,
			appId,
		});
		return { success: false, status: 502 };
	}

	const customProperties = source.profile.custom_properties;
	if (
		customProperties !== undefined &&
		(!isRecord(customProperties) ||
			Object.values(customProperties).some(
				(value) => typeof value !== "string",
			))
	) {
		log.error(
			"[commcare] app source custom profile properties are malformed",
			undefined,
			{ domain, appId },
		);
		return { success: false, status: 502 };
	}

	return { profile: source.profile };
}
