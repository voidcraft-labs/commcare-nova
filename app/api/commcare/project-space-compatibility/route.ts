/**
 * Read-only publish preflight for a CommCare HQ project space.
 *
 * With no domain this describes what the app needs in semantic product terms.
 * With a selected domain it also checks whether that project space can run the
 * app. Private HQ probes stay behind the CommCare boundary.
 */

import type { NextRequest } from "next/server";
import {
	ApiError,
	BLUEPRINT_REQUEST_MAX_BYTES,
	handleApiError,
	readJsonBody,
} from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import {
	isValidDomainSlug,
	probeHqProjectSpaceCompatibility,
} from "@/lib/commcare/client";
import {
	projectSpaceCompatibilityForPrepublish,
	projectSpaceCompatibilityProbePlan,
} from "@/lib/commcare/projectSpaceCompatibility";
import { resolveAppAccess } from "@/lib/db/appAccess";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain";
import { projectSpaceCompatibilityForTarget } from "@/lib/publish/projectSpaceCompatibility";

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

		const access = await resolveAppAccess(appId, session.user.id, "view");
		const doc = hydratePersistedBlueprint(
			access.app.blueprint as PersistableDoc,
		);
		let report = projectSpaceCompatibilityForPrepublish(doc);
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

			const plan = projectSpaceCompatibilityProbePlan(doc);
			const probes = await probeHqProjectSpaceCompatibility(
				credentialResult.creds,
				credentialResult.domain.name,
				plan,
			);
			report = projectSpaceCompatibilityForTarget(
				credentialResult.domain.name,
				probes.capabilities,
				probes.advisories,
			);
		}

		return Response.json(
			{ project_space_compatibility: report },
			{ headers: { "Cache-Control": "private, no-store" } },
		);
	} catch (err) {
		const response = handleApiError(
			err instanceof Error
				? err
				: new ApiError(
						"Nova couldn't check whether this project space can run the app",
						500,
					),
		);
		response.headers.set("Cache-Control", "private, no-store");
		return response;
	}
}
