import "server-only";

/**
 * The check Nova makes once, unasked, when the builder opens an app: which
 * project spaces hold a copy of this app that changed in CommCare HQ, among
 * those Nova could ask. It writes nothing: no baseline, no fold and no
 * notification. Only a deployment with a usable pair (`usablePair`) is
 * asked about, since a change there is one a review can bring in.
 *
 * Each deployment is read with the member's own key, one after another,
 * each read under its own deadline (the source read's), and each baseline
 * is unzipped and verified once, for the pair test and the comparison both:
 * the answer is a hint nobody waits on, so it takes one connection and one
 * read of CommCare HQ at a time, and stops reading when the request is
 * cancelled. A deployment is listed only where the answer is `changed`.
 * Everything else is not listed, and a failure is logged at warn with the
 * app's id alone. Reached through a Route Handler's `fetch`, never a Server
 * Action, so no other action of the tab waits on CommCare HQ's answer.
 */

import { greatestFoldBaselineSeq } from "@/lib/agent/change-set/baseLoader";
import { getAppDb } from "@/lib/db/pg";
import { log } from "@/lib/logger";
import { activeRemoteApp } from "../resources";
import { peekReadDeploymentChanged } from "../service";
import {
	type DeploymentScope,
	type DeploymentTargetKey,
	readAppBaseline,
	readDeploymentsForApp,
} from "../store";
import { usablePair } from "./reference";

/** The project spaces whose copy of this app changed, among those Nova could ask. */
export async function checkHqChangesForApp(
	scope: DeploymentScope,
	options: { readonly cancel?: AbortSignal },
): Promise<readonly DeploymentTargetKey[]> {
	const deployments = await readDeploymentsForApp(scope);
	if (deployments.length === 0) return [];
	const foldSeq = await greatestFoldBaselineSeq(await getAppDb(), scope.appId);
	const changed: DeploymentTargetKey[] = [];
	for (const deployment of deployments) {
		if (options.cancel?.aborted === true) break;
		const target: DeploymentTargetKey = {
			server: deployment.deployment.server,
			domain: deployment.deployment.domain,
		};
		try {
			const baseline = await readAppBaseline(scope, target);
			if (!usablePair(baseline, activeRemoteApp(deployment), foldSeq)) continue;
			const answer = await peekReadDeploymentChanged(
				scope,
				deployment,
				baseline,
				options,
			);
			if (answer === "changed") changed.push(target);
		} catch {
			log.warn("[hq-changes] check failed", { appId: scope.appId });
		}
	}
	return changed;
}
