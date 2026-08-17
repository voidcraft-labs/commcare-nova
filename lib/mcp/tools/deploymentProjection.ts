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
 *   - `left_behind`. Apps this deployment once pointed at and no longer
 *     does: publishes made before Nova updated apps in place created a new
 *     app beside the old one each time, and a recreate after the mapped
 *     app was deleted on CommCare HQ supersedes the dead mapping. An
 *     ordinary republish updates the same app and adds nothing here.
 *     Reporting them is the contract; a client that omits it lets an
 *     author accumulate abandoned apps without ever being told.
 */

import { activeRemoteApp } from "@/lib/deployment/resources";
import { deploymentResumeState } from "@/lib/deployment/stateMachine";
import type {
	DeploymentPhase,
	DeploymentWithResources,
} from "@/lib/deployment/types";
import { DEPLOYMENT_PHASES } from "@/lib/deployment/types";

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
	/** CommCare HQ apps this deployment once pointed at; a later publish
	 * superseded them rather than updating them in place. */
	readonly left_behind: readonly string[];
}

export function describeDeployment(
	view: DeploymentWithResources,
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
		left_behind: view.superseded
			.filter((resource) => resource.kind === "app")
			.map((resource) => resource.remoteId),
	};
}
