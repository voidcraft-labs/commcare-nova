/**
 * The one MCP projection of a deployment.
 *
 * Every deployment-bearing tool result goes through this, so a client
 * learns one shape rather than three near-identical ones. It is a
 * projection, not a second schema: nothing here is stored, and nothing
 * here is accepted as input.
 *
 * Two things it always carries, because a client that guesses either gets
 * them wrong:
 *
 *   - `state` alongside `retry_from`. A deployment in `incomplete` names
 *     the phase a retry re-enters, so "what do I do next" has an answer
 *     rather than being inferred from which fields are empty.
 *   - `left_behind`. Everything this deployment once pointed at and no
 *     longer does: apps from publishes made before Nova updated them in
 *     place, an app superseded after being deleted on CommCare HQ, a
 *     lookup table the app no longer points at (its tag renamed, or the
 *     last select reading it gone), and a place the app archived, which
 *     CommCare HQ's location API offers Nova no way to take down. An
 *     ordinary republish updates the same resources and adds nothing
 *     here. Reporting them is the contract, and Nova never deletes
 *     a remote resource; a client that omits it lets an author accumulate
 *     abandoned apps, tables, and places without ever being told.
 */

import {
	activeRemoteApp,
	leftBehindResources,
} from "@/lib/deployment/resources";
import { deploymentResumeState } from "@/lib/deployment/stateMachine";
import type {
	DeploymentPhase,
	DeploymentResourceKind,
	DeploymentWithResources,
} from "@/lib/deployment/types";
import { DEPLOYMENT_PHASES } from "@/lib/deployment/types";

/** One remote resource an earlier publish left on the project space. */
export interface LeftBehindResource {
	readonly kind: DeploymentResourceKind;
	/** CommCare HQ's own id, which is how a person finds it there. */
	readonly hq_id: string;
	/**
	 * The name it carries on CommCare HQ: a lookup table's tag, or a
	 * place's site code. Null for an app, whose id IS how CommCare HQ
	 * names it.
	 */
	readonly hq_name: string | null;
}

export interface DeploymentProjection {
	readonly server: string;
	readonly domain: string;
	readonly state: string;
	/** The phase a retry re-enters. Null unless the state is `incomplete`. */
	readonly retry_from: DeploymentPhase | null;
	/** The state that retry resumes from. Null unless `incomplete`. */
	readonly retry_from_state: string | null;
	readonly hq_app_id: string | null;
	readonly ownership: string | null;
	/** The Nova mutation sequence the remote app was built from. */
	readonly pushed_revision: number | null;
	/** CommCare HQ's own version number at the last check. */
	readonly remote_revision: number | null;
	readonly last_checked_at: string | null;
	readonly phases: Readonly<
		Record<
			DeploymentPhase,
			{ readonly status: string; readonly detail: string | null } | null
		>
	>;
	/** Remote resources this deployment once pointed at; a later publish
	 * superseded them rather than updating them in place. */
	readonly left_behind: readonly LeftBehindResource[];
}

/**
 * Project one deployment.
 *
 * `currentIdentities` maps each of the app's pushable Nova resources to
 * the name it carries NOW (`service.ts::currentResourceIdentities`), which
 * is what tells a superseded row apart from a genuinely abandoned one: a
 * table recreated after being deleted on CommCare HQ supersedes its
 * mapping and leaves nothing behind, while a renamed one leaves the old
 * table sitting there. Pass `null` when Nova could not read them, and only
 * superseded apps are reported: sending somebody to tidy up tables that
 * are perfectly fine is worse than saying less.
 */
export function describeDeployment(
	view: DeploymentWithResources,
	currentIdentities: ReadonlyMap<string, string> | null,
): DeploymentProjection {
	const record = view.deployment;
	const remote = activeRemoteApp(view);
	const phases = Object.fromEntries(
		DEPLOYMENT_PHASES.map((phase) => {
			const outcome = record.phases[phase];
			if (outcome === null) return [phase, null] as const;
			return [
				phase,
				{
					status: outcome.status,
					detail:
						outcome.status === "pending"
							? outcome.reason
							: outcome.status === "failed"
								? outcome.failure.message
								: null,
				},
			] as const;
		}),
	) as DeploymentProjection["phases"];

	return {
		server: record.server,
		domain: record.domain,
		state: record.state,
		retry_from: record.resumePhase,
		retry_from_state: deploymentResumeState(record),
		hq_app_id: remote?.remoteId ?? null,
		ownership: remote?.ownership ?? null,
		pushed_revision: remote?.pushedRevision ?? null,
		remote_revision: remote?.remoteRevision ?? null,
		last_checked_at: record.lastObservedAt,
		phases,
		left_behind: (currentIdentities === null
			? view.superseded.filter((resource) => resource.kind === "app")
			: leftBehindResources(view, currentIdentities)
		).map((resource) => ({
			kind: resource.kind,
			hq_id: resource.remoteId,
			hq_name: resource.pushedIdentity,
		})),
	};
}
