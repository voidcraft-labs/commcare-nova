import "server-only";

import { probeHqProjectSpaceCompatibility } from "@/lib/commcare/client";
import { projectSpaceCompatibilityProbePlan } from "@/lib/commcare/projectSpaceCompatibility";
import { getHqCredentials } from "@/lib/db/settings";
import { DeploymentError } from "./errors";
import type { ProjectSearchDestinationEdit } from "./projectSearchDestinationInput";
import {
	type DeploymentScope,
	type DeploymentTargetKey,
	inspectProjectSearchDestination,
	saveProjectSearchDestination,
} from "./store";

/** Confirm only capabilities the signed-in editor can read in this exact space.
 * The endpoint definition and its current result columns are private to HQ.
 * The supplied numbers identify services the editor chose there. */
export async function configureProjectSearchDestination(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	edit: ProjectSearchDestinationEdit,
) {
	const inspected = await inspectProjectSearchDestination(
		scope,
		target,
		"edit",
	);
	if (inspected.review.version !== edit.version)
		throw new DeploymentError(
			"invalid",
			"This app or destination changed. Review its searches again before connecting them.",
		);
	const creds = await getHqCredentials(scope.actorUserId, target.domain);
	if (
		!creds.ok ||
		creds.creds.server !== target.server ||
		creds.domain.name !== target.domain
	)
		throw new DeploymentError(
			"domain_not_authorized",
			"Connect an account that can check searches in this project space.",
		);
	const plan = projectSpaceCompatibilityProbePlan(inspected.doc);
	const feature = plan.capabilities.filter(
		(row) => row.capability.id === "project-search",
	);
	if (!feature.length)
		throw new DeploymentError(
			"invalid",
			"This app has no search supplied by the project space.",
		);
	const { report } = await probeHqProjectSpaceCompatibility(
		creds.creds,
		target.domain,
		{ capabilities: feature, advisories: [] },
	);
	if (
		report.required_capabilities.find((row) => row.id === "project-search")
			?.state !== "available"
	)
		throw new DeploymentError(
			"invalid",
			"Nova couldn't confirm that this project space supports the app's searches. Check its search settings and try again.",
		);
	return saveProjectSearchDestination(scope, target, edit);
}
