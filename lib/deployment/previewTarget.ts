// lib/deployment/previewTarget.ts
//
// Which project space Preview may honestly say a worker signed into.
//
// Pure, so both the server that resolves it and any surface that explains
// it read the same rule.

import { deploymentHasReached } from "./stateMachine";
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
 * A deployment counts only once it has reached `uploaded`: before that the
 * app is not on that project space at all, so a worker could not have
 * signed into it. `incomplete` never counts, whatever it failed at,
 * because a refused deployment has reached nothing.
 *
 * Several qualifying deployments produce `ambiguous` rather than a pick.
 * The same refusal `resolveUploadDomain` makes for an upload target: with
 * two real answers, choosing one silently would make a condition on
 * `commcare_project` pass in Preview and fail for half the workers.
 */
export function resolvePreviewDeploymentTarget(
	deployments: readonly Pick<DeploymentRecord, "state" | "domain">[],
): PreviewDeploymentTarget {
	const live = deployments.filter((deployment) =>
		deploymentHasReached(deployment, "uploaded"),
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
 * what CommCare does for a value it has not got — never an empty string,
 * because a declared-but-blank property and a missing one behave
 * differently under a `= ''` comparison.
 */
export function previewProjectSpace(
	target: PreviewDeploymentTarget,
): string | null {
	return target.kind === "known" ? target.domain : null;
}
