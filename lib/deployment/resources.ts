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
 * The mapped CommCare HQ app the next publish will update in place, or
 * `null` when it will create a fresh one.
 *
 * An active mapping whose upload phase holds no persisted failure means
 * the project space still holds the app Nova put there, so a publish
 * updates it. The predicate is ANY persisted upload failure, not the
 * `remote_app_missing` code alone: attempt failures are never persisted
 * on a reached target (`applyAttemptOutcome` returns the record
 * unchanged), so a failure sitting beside an active mapping implies a
 * prior observation found the app gone, even when a later failed create
 * attempt overwrote the code. Keying on the code would send that state
 * back down the update path against an app CommCare HQ already said is
 * missing. The one imperfect corner: an app restored through CommCare
 * HQ's own undo and never re-observed gets a fresh copy instead of an
 * update. Rare and non-destructive. A Check status before publishing
 * heals it, but only while the persisted failure still carries the
 * `remote_app_missing` code (`deploymentIsObservable` whitelists exactly
 * that); a later failed create attempt that overwrote the code closes
 * that window until a publish lands and `recordRemoteResource` clears
 * the failure.
 *
 * Shared by the publish lifecycle (the decision itself) and the publish
 * dialog (the copy saying which will happen), so the promise on the
 * screen and the request that follows cannot drift.
 */
export function plannedInPlaceUpdate(
	deployment: DeploymentWithResources,
): DeploymentResource | null {
	const active = activeRemoteApp(deployment);
	if (active === null) return null;
	if (deployment.deployment.phases.upload?.status === "failed") return null;
	return active;
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
	currentIdentities: ReadonlyMap<string, string>,
): readonly DeploymentResource[] {
	return deployment.superseded.filter((resource) => {
		if (resource.kind === "app") return true;
		if (resource.pushedIdentity === null) return false;
		const current = currentIdentities.get(resource.novaResourceId);
		/* The Nova resource itself is gone — deleted, or no longer
		 * referenced by this app — so whatever was pushed under its name is
		 * certainly still there and nothing in Nova names it any more. */
		if (current === undefined) return true;
		return current !== resource.pushedIdentity;
	});
}
