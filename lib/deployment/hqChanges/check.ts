import "server-only";

/**
 * The check Nova makes once, unasked, when the builder opens an app: which
 * project spaces hold a copy of this app that changed in CommCare HQ, among
 * those Nova could ask. It writes nothing: no baseline, no fold and no
 * notification. Only a deployment with a usable pair (`usablePair`) is
 * asked about, since a change there is one a review can bring in.
 *
 * Each deployment is read with the member's own key, all at once, each read
 * under its own deadline (the source read's), and a deployment is listed
 * only where the answer is `changed`. Everything else is not listed, and a
 * failure is logged at warn with the app's id alone. Reached through a
 * Route Handler's `fetch`, never a Server Action, so no other action of the
 * tab waits on CommCare HQ's answer.
 */

import { greatestFoldBaselineSeq } from "@/lib/agent/change-set/baseLoader";
import { getAppDb } from "@/lib/db/pg";
import { log } from "@/lib/logger";
import { activeRemoteApp } from "../resources";
import { peekHqAppChanged } from "../service";
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
	const answers = await Promise.all(
		deployments.map(async (deployment) => {
			const target: DeploymentTargetKey = {
				server: deployment.deployment.server,
				domain: deployment.deployment.domain,
			};
			try {
				const baseline = await readAppBaseline(scope, target);
				if (!usablePair(baseline, activeRemoteApp(deployment), foldSeq))
					return null;
				const answer = await peekHqAppChanged(scope, target, options);
				return answer === "changed" ? target : null;
			} catch {
				log.warn("[hq-changes] check failed", { appId: scope.appId });
				return null;
			}
		}),
	);
	return answers.filter((target) => target !== null);
}
