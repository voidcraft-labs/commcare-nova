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

/**
 * The mapped CommCare HQ app the next publish updates in place, or `null`
 * when it creates one.
 *
 * A live mapping is updated in place whether or not it holds content yet: a
 * shell Nova created and never filled is filled by the next publish, never
 * made a second time. A mapping CommCare HQ reported gone
 * (`remoteMissingAt`) is created afresh.
 *
 * Shared by the publish lifecycle (the decision itself) and the publish
 * dialog (the copy saying which will happen), so the promise on the
 * screen and the request that follows cannot drift.
 */
export function plannedInPlaceUpdate(
	deployment: DeploymentWithResources,
): DeploymentResource | null {
	const active = activeRemoteApp(deployment);
	return active === null || active.remoteMissingAt !== null ? null : active;
}

/**
 * False for a shell Nova created and never filled.
 *
 * The first publish creates an empty app, then fills it with an update; the
 * mapping carries no pushed revision until that update lands.
 */
export function remoteAppHoldsContent(resource: DeploymentResource): boolean {
	return resource.pushedRevision !== null;
}

/**
 * The mapped app when CommCare HQ holds this app's content there, else
 * `null`: a shell holds nothing to sign in to or link into, and a gone app
 * holds nothing at all.
 */
export function publishedRemoteApp(
	deployment: DeploymentWithResources,
): DeploymentResource | null {
	const planned = plannedInPlaceUpdate(deployment);
	return planned !== null && remoteAppHoldsContent(planned) ? planned : null;
}

/** What the next publish to a target does with the app there. */
export type NextPublishAction = "creates" | "fills-shell" | "updates";

/**
 * What the next publish does: create an app, fill the empty one an earlier
 * try made, or update the app that is there. `null` is a target this app
 * has no deployment on.
 */
export function nextPublishAction(
	deployment: DeploymentWithResources | null,
): NextPublishAction {
	const planned = deployment === null ? null : plannedInPlaceUpdate(deployment);
	if (planned === null) return "creates";
	return remoteAppHoldsContent(planned) ? "updates" : "fills-shell";
}

/**
 * CommCare HQ reported the active mapped app gone; false when there is no
 * active mapping.
 *
 * Read from the mapping rather than from a failure code, so it still holds
 * after a later failed create overwrote the code.
 */
export function remoteAppReportedGone(
	deployment: DeploymentWithResources,
): boolean {
	return (activeRemoteApp(deployment)?.remoteMissingAt ?? null) !== null;
}

/**
 * The remote resources an earlier publish left on the project space under
 * a name this app no longer uses.
 *
 * A superseded mapping is not automatically something left behind. When a
 * lookup table is deleted on CommCare HQ and the next push recreates it,
 * the mapping is superseded because the remote id changed, but nothing is
 * sitting there: the old table is gone and the new one carries the same
 * name. What genuinely remains is a resource whose PUSHED NAME differs
 * from the one its Nova resource carries now — a rename, where Nova made
 * a new table and, per the deployment contract, did not delete the old
 * one.
 *
 * So the test is the name, not the supersession. Reporting every
 * superseded row would tell an author to go and clean up tables that do
 * not exist, which costs them a trip to CommCare HQ to find nothing.
 *
 * The other way in is a table the app STOPPED reading. Its mapping is
 * superseded by the push that no longer names it
 * (`store.ts::recordPushedResources`), and no current identity answers to
 * its Nova id, so the `current === undefined` arm reports it. Nova still
 * deletes nothing; it stops claiming the table and starts naming it.
 */
export function leftBehindResources(
	deployment: DeploymentWithResources,
	currentIdentities: ReadonlyMap<string, string> | null,
): readonly DeploymentResource[] {
	// History can contain several past mappings to the same remote object,
	// including one the current publish uses again. Report remote objects once
	// and never suggest cleanup of an object that is active now.
	const key = (resource: DeploymentResource) =>
		`${resource.kind}:${resource.remoteId}`;
	const active = new Set(deployment.active.map(key));
	const historical = new Map(
		deployment.superseded.map((resource) => [key(resource), resource]),
	);
	return [...historical.values()].filter((resource) => {
		if (active.has(key(resource))) return false;
		if (resource.kind === "app") return true;
		// Unavailable names are not evidence that every named resource vanished.
		if (currentIdentities === null || resource.pushedIdentity === null)
			return false;
		const current = currentIdentities.get(resource.novaResourceId);
		/* The Nova resource itself is gone — deleted, or no longer
		 * referenced by this app — so whatever was pushed under its name is
		 * certainly still there and nothing in Nova names it any more. */
		if (current === undefined) return true;
		return current !== resource.pushedIdentity;
	});
}
