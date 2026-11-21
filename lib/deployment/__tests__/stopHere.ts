/**
 * Stop publishing to a project space as a person does from its card: naming
 * the HQ app the deployment's live mapping holds as they read it.
 */

import { activeRemoteApp } from "../resources";
import {
	type DeploymentScope,
	type DeploymentTargetKey,
	endDeployment,
	readDeployment,
} from "../store";
import type { DeploymentWithResources } from "../types";

export async function stopHere(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
): Promise<DeploymentWithResources> {
	const view = await readDeployment(scope, target);
	const live = view === null ? null : activeRemoteApp(view);
	if (live === null) {
		throw new Error(
			`The test stopped publishing to “${target.domain}”, where this app publishes to no HQ app.`,
		);
	}
	return endDeployment(scope, target, live.remoteId);
}
