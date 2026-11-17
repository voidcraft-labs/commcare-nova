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
 *
 * And two that say where the app stands with that project space:
 * `brought_in`, where the app came from CommCare HQ there, and `ending`,
 * where Nova stopped publishing there. Both are read from the mappings,
 * never from the state, by the rules the Publishing card reads.
 */

import { confirmationLabel } from "@/lib/deployment/confirmations";
import {
	activeRemoteApp,
	deploymentEnding,
	leftBehindResources,
	remoteAppHoldsContent,
	remoteAppReportedGone,
} from "@/lib/deployment/resources";
import { deploymentResumeState } from "@/lib/deployment/stateMachine";
import type {
	DeploymentKept,
	DeploymentPhase,
	DeploymentResourceKind,
	DeploymentState,
	DeploymentWithResources,
} from "@/lib/deployment/types";
import { DEPLOYMENT_PHASES } from "@/lib/deployment/types";
import { driftDate } from "@/lib/publish/driftReference";
import type { FirstPublishLines } from "@/lib/publish/firstPublishCopy";
import { KEPT_LABELS } from "@/lib/publish/keptValues";
import { endedLine } from "@/lib/publish/stopPublishing";

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
	/** Any of `DEPLOYMENT_STATES`, `ended` among them. */
	readonly state: DeploymentState;
	/** The phase a retry re-enters. Null unless the state is `incomplete`. */
	readonly retry_from: DeploymentPhase | null;
	/** The state that retry resumes from. Null unless `incomplete`. */
	readonly retry_from_state: string | null;
	/** The HQ app id Nova holds for this project space, whatever it knows of the app. */
	readonly hq_app_id: string | null;
	/** CommCare HQ reported that app gone; the next publish makes a new one. */
	readonly hq_app_gone: boolean;
	/**
	 * The app there is the empty one a first publish makes before it sends
	 * the content; the next publish fills it.
	 */
	readonly hq_app_empty: boolean;
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
	/**
	 * What a person confirmed about this project space that is still in
	 * force, which a publish there does not ask again. `confirmed_by` is
	 * the member's display name.
	 */
	readonly confirmations: readonly DeploymentConfirmationProjection[];
	/**
	 * The settings this project space keeps in CommCare HQ at another value
	 * than a new app's, each worded as the Publishing card words it, in the
	 * card's order, and `observed_at`, the instant Nova read them. Null where
	 * Nova holds no read of the app there; absent from an upload's answer
	 * where Nova could not read the list after the app landed.
	 */
	readonly kept?: {
		readonly labels: readonly string[];
		readonly observed_at: string;
	} | null;
	/**
	 * The app came from CommCare HQ on this project space: when it was
	 * brought in, and the member's display name. Null for an app Nova made
	 * there, and where the deployment has no live app mapping.
	 */
	readonly brought_in: {
		readonly at: string;
		readonly by: string;
	} | null;
	/**
	 * Nova stopped publishing this app here: when, who (a display name), why,
	 * the HQ app that stays there, and the sentence the Publishing card shows,
	 * with the day in UTC. Null while the deployment stands at no ending.
	 * Where another Nova app publishes to that HQ app now,
	 * `held_by_another_app` is true and `hq_app_id` is left out: that app is
	 * no longer this one's to offer a way back to, and the card offers none.
	 */
	readonly ending: {
		readonly at: string;
		readonly by: string;
		readonly reason: "stopped" | "claimed-elsewhere";
		readonly held_by_another_app: boolean;
		readonly hq_app_id?: string;
		readonly message: string;
	} | null;
}

/** One confirmation in force on a deployment. */
export interface DeploymentConfirmationProjection {
	readonly kind: string;
	readonly subject: string;
	readonly label: string;
	readonly confirmed_by: string;
	readonly confirmed_at: string;
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
 * are perfectly fine is worse than saying less. `kept` is the deployment's
 * kept list (`service.ts::deploymentKept`), or `unread` where an upload, a
 * check or a kept refresh whose write landed could not read it
 * (`service.ts::landedDeploymentKept`), which leaves the field out.
 */
export function describeDeployment(
	view: DeploymentWithResources,
	currentIdentities: ReadonlyMap<string, string> | null,
	kept: DeploymentKept | null | "unread",
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

	const ending = deploymentEnding(view);

	return {
		server: record.server,
		domain: record.domain,
		state: record.state,
		retry_from: record.resumePhase,
		retry_from_state: deploymentResumeState(record),
		hq_app_id: remote?.remoteId ?? null,
		hq_app_gone: remoteAppReportedGone(view),
		hq_app_empty:
			remote !== null &&
			remote.remoteMissingAt === null &&
			!remoteAppHoldsContent(remote),
		ownership: remote?.ownership ?? null,
		pushed_revision: remote?.pushedRevision ?? null,
		remote_revision: remote?.remoteRevision ?? null,
		last_checked_at: record.lastObservedAt,
		phases,
		left_behind: leftBehindResources(view, currentIdentities).map(
			(resource) => ({
				kind: resource.kind,
				hq_id: resource.remoteId,
				hq_name: resource.pushedIdentity,
			}),
		),
		confirmations: view.confirmations.map((confirmation) => ({
			kind: confirmation.kind,
			subject: confirmation.subject,
			label: confirmationLabel(confirmation),
			confirmed_by: confirmation.confirmedByName,
			confirmed_at: confirmation.confirmedAt,
		})),
		/* An app mapping is `adopted` by one route only: the app was brought in
		 * from CommCare HQ, and its birth records who and when. */
		brought_in:
			remote !== null &&
			remote.ownership === "adopted" &&
			remote.adoptedAt !== null
				? { at: remote.adoptedAt, by: remote.adoptedByName ?? "Someone" }
				: null,
		ending:
			ending === null
				? null
				: {
						at: ending.at,
						by: ending.byName,
						reason: ending.reason,
						held_by_another_app: ending.heldByAnotherApp,
						...(!ending.heldByAnotherApp && { hq_app_id: ending.hqAppId }),
						message: endedLine(ending, driftDate(ending.at)),
					},
		...(kept !== "unread" && {
			kept:
				kept === null
					? null
					: {
							labels: kept.labels.map((label) => KEPT_LABELS[label]),
							observed_at: kept.observedAt,
						},
		}),
	};
}

/** `firstPublishLines`' answer as MCP serves it: the same lines, with its keys in snake case. */
export interface FirstPublishProjection {
	readonly heading: string;
	readonly lead: string;
	readonly workers: {
		readonly label: string;
		readonly lines: readonly {
			readonly id: string;
			readonly sentence: string;
		}[];
	};
	readonly hq_only: {
		readonly label: string;
		readonly lines: readonly {
			readonly id: string;
			readonly sentence: string;
		}[];
	};
	readonly reassurance: string | null;
	readonly note: string;
}

/**
 * Project the lines a surface shows of a first-publish (or next-publish)
 * list. Every MCP answer that carries one goes through this, so each
 * serves the words the builder shows, in the same order.
 */
export function describeFirstPublish(
	lines: FirstPublishLines,
): FirstPublishProjection {
	return {
		heading: lines.heading,
		lead: lines.lead,
		workers: {
			label: lines.workers.label,
			lines: lines.workers.lines.map(({ id, sentence }) => ({ id, sentence })),
		},
		hq_only: {
			label: lines.hqOnly.label,
			lines: lines.hqOnly.lines.map(({ id, sentence }) => ({ id, sentence })),
		},
		reassurance: lines.reassurance,
		note: lines.note,
	};
}
