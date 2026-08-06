// lib/deployment/previewTarget.ts
//
// Which project space Preview may honestly say a worker signed into.
//
// Pure, so both the server that resolves it and any surface that explains
// it read the same rule.

import { deploymentDisplaysAsReached } from "./stateMachine";
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
 * The same refusal `resolveUploadDomain` makes for an upload target: with
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
