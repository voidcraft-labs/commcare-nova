/**
 * Read-only publish preflight for the current app's CommCare HQ feature flags.
 * With no domain it returns exact app requirements; with a selected domain it
 * also probes current HQ state. This stays under the CommCare API boundary so
 * the browser can use the wire-aware detector without importing or duplicating
 * it.
 */

import type { NextRequest } from "next/server";
import {
	ApiError,
	BLUEPRINT_REQUEST_MAX_BYTES,
	handleApiError,
	readJsonBody,
} from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { isValidDomainSlug, probeHqFeatureFlags } from "@/lib/commcare/client";
import {
	featureFlagReportForPrepublish,
	featureFlagReportForUpload,
	requiredHqFeatureFlags,
} from "@/lib/commcare/featureFlags";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain";

export async function POST(req: NextRequest) {
	try {
		const session = await requireSession(req);
		const body = await readJsonBody(req, BLUEPRINT_REQUEST_MAX_BYTES);
		const request = body as { appId?: unknown; domain?: unknown } | null;
		const appId = request?.appId;
		if (typeof appId !== "string") {
			throw new ApiError("appId is required", 400);
		}
		if (
			request?.domain !== undefined &&
			(typeof request.domain !== "string" ||
				!isValidDomainSlug(request.domain.trim()))
		) {
			throw new ApiError("Invalid project space name", 400);
		}

		// Same Project-view gate and persisted document source used by compile.
		// The app-only preflight stops here; a selected domain additionally uses
		// the caller's stored credentials for a read-only HQ probe below. Neither
		// path compiles the app or reads its external resources.
		const access = await resolveAppAccess(appId, session.user.id, "view");
		const doc = hydratePersistedBlueprint(
			access.app.blueprint as PersistableDoc,
		);
		let report = featureFlagReportForPrepublish(doc);
		const domain =
			typeof request?.domain === "string" ? request.domain.trim() : "";
		if (domain) {
			const credentialResult = await getCredentialsForUpload(
				session.user.id,
				domain,
			);
			if (!credentialResult.ok) {
				if (credentialResult.error === "not_configured") {
					throw new ApiError(
						"CommCare HQ is not configured. Add your API key in Settings.",
						400,
					);
				}
				if (credentialResult.error === "not_authorized") {
					throw new ApiError(
						`Your API key cannot inspect the “${domain}” project space.`,
						403,
					);
				}
				throw new ApiError("Choose a project space to check.", 400);
			}
			const probes = await probeHqFeatureFlags(
				credentialResult.creds,
				credentialResult.domain.name,
				requiredHqFeatureFlags(doc),
			);
			report = featureFlagReportForUpload(
				credentialResult.domain.name,
				probes,
				"prepublish",
			);
		}

		return Response.json(
			{ feature_flag_requirements: report },
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (err) {
		const response = handleApiError(
			err instanceof Error
				? err
				: new ApiError("Failed to inspect feature-flag requirements", 500),
		);
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	}
}
