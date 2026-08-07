// lib/deployment/resources.ts
//
// Pure selectors over a deployment that has already been loaded.
//
// Their own module rather than members of `store.ts`, because they touch
// no database: they are the answer to "which CommCare HQ thing does this
// record point at right now", and every surface that renders or projects a
// deployment needs it. Living beside the persistence layer made them
// unreachable from a unit test without mocking Postgres, which two test
// files had already worked around by re-implementing them: a copy of a
// rule is a rule that can drift.

import type {
	DeploymentResource,
	DeploymentResourceKind,
	DeploymentWithResources,
} from "./types";

/** The mapping currently in force for one Nova resource, if there is one. */
export function activeResource(
	deployment: DeploymentWithResources,
	kind: DeploymentResourceKind,
	novaResourceId: string,
): DeploymentResource | null {
	return (
		deployment.active.find(
			(resource) =>
				resource.kind === kind && resource.novaResourceId === novaResourceId,
		) ?? null
	);
}

/**
 * The CommCare HQ app this deployment currently points at.
 *
 * The app's own Nova id is the resource id for the `app` kind, so this is
 * a lookup rather than a special case in the table.
 */
export function activeRemoteApp(
	deployment: DeploymentWithResources,
): DeploymentResource | null {
	return activeResource(deployment, "app", deployment.deployment.appId);
}
