// lib/deployment/previewTarget.ts
//
// Which project space Preview may honestly say a worker signed into.
//
// Pure, so both the server that resolves it and any surface that explains
// it read the same rule.

import { deploymentDisplaysAsReached } from "./stateMachine";
import type { DeploymentTargetKey } from "./store";
import type { DeploymentRecord } from "./types";

/** What Preview shows for `commcare_project`, and why. */
export type PreviewDeploymentTarget =
	| { readonly kind: "known"; readonly domain: string }
	/** No project space holds this app yet. */
	| { readonly kind: "none" }
	/** Several do, so naming one would be a guess. */
	| { readonly kind: "ambiguous"; readonly domains: readonly string[] };

/**
 * Resolve the one project space Preview can name.
 *
 * A deployment counts once its app is genuinely on that project space, so
 * a worker could have signed into it. That is `deploymentDisplaysAsReached`
 * rather than the strict predicate, and the difference matters: a probe
 * that failed did not undo the upload, and letting a transient "Nova could
 * not check" withdraw `commcare_project` would change what expressions
 * evaluate to for a reason that has nothing to do with the app. A
 * deployment refused BEFORE its app got there still counts for nothing.
 *
 * Several qualifying deployments produce `ambiguous` rather than a pick.
 * The same refusal `resolveHqDomain` makes for an upload target: with
 * two real answers, choosing one silently would make a condition on
 * `commcare_project` pass in Preview and fail for half the workers.
 */
export function resolvePreviewDeploymentTarget(
	deployments: readonly Pick<
		DeploymentRecord,
		"state" | "resumePhase" | "domain"
	>[],
): PreviewDeploymentTarget {
	const live = deployments.filter((deployment) =>
		deploymentDisplaysAsReached(deployment, "uploaded"),
	);
	const domains = [...new Set(live.map((deployment) => deployment.domain))];
	const only = domains[0];
	if (domains.length === 1 && only !== undefined) {
		return { kind: "known", domain: only };
	}
	if (domains.length === 0) return { kind: "none" };
	return { kind: "ambiguous", domains };
}

/**
 * The `commcare_project` value, or `null` when Nova cannot honestly supply
 * one.
 *
 * `null` means the key is ABSENT from the session block, which is exactly
 * what CommCare does for a value it has not got; never an empty string,
 * because a declared-but-blank property and a missing one behave
 * differently under a `= ''` comparison.
 */
export function previewProjectSpace(
	target: PreviewDeploymentTarget,
): string | null {
	return target.kind === "known" ? target.domain : null;
}

/**
 * The one project space whose kept settings Preview plays, or `null` for
 * none or several.
 *
 * The same rule that names `commcare_project`: a deployment counts once it
 * displays as uploaded, and with two real answers Preview takes neither.
 * It tells deployments apart by server and domain together, where the
 * project space's name tells them apart by the domain alone, because the
 * facts are one deployment's: one domain on two servers is two project
 * spaces that may hold different settings.
 */
export function resolvePreviewFactsTarget(
	deployments: readonly Pick<
		DeploymentRecord,
		"state" | "resumePhase" | "server" | "domain"
	>[],
): DeploymentTargetKey | null {
	const targets = new Map<string, DeploymentTargetKey>();
	for (const deployment of deployments) {
		if (!deploymentDisplaysAsReached(deployment, "uploaded")) continue;
		targets.set(JSON.stringify([deployment.server, deployment.domain]), {
			server: deployment.server,
			domain: deployment.domain,
		});
	}
	const [only, ...others] = targets.values();
	return only !== undefined && others.length === 0 ? only : null;
}
