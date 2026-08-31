/**
 * Rollout bridge for Builder tabs loaded before project-space compatibility.
 *
 * Those bundles keep this URL in memory across a deploy and use any successful
 * legacy-shaped response only as permission to enable the Upload button. The
 * current route performs the real semantic check; this adapter projects its
 * result without exposing the private CommCare HQ settings behind it. The
 * authoritative upload preflight still checks the destination immediately
 * before every remote write.
 */

import type { NextRequest } from "next/server";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import { legacyFeatureFlagCompatibilityReport } from "@/lib/publish/projectSpaceCompatibilityLegacy";
import { POST as checkProjectSpaceCompatibility } from "../project-space-compatibility/route";

export async function POST(req: NextRequest) {
	const response = await checkProjectSpaceCompatibility(req);
	if (!response.ok) return response;

	const body = (await response.json()) as {
		project_space_compatibility: ProjectSpaceCompatibilityReport;
	};
	return Response.json(
		{
			feature_flag_requirements: legacyFeatureFlagCompatibilityReport(
				body.project_space_compatibility,
			),
		},
		{
			status: response.status,
			headers: { "Cache-Control": "private, no-store" },
		},
	);
}
