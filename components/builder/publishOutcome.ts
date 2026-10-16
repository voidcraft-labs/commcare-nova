/**
 * What a publish response means, as one pure decision.
 *
 * It lives outside the dialog because getting it wrong is invisible in a
 * screenshot and expensive in practice: the first version branched on
 * `success` alone and threw away the durable record a refused publish
 * answers with, so the phase that stopped and the state a retry resumes
 * from never reached the screen. That is exactly the thing the deployment
 * record exists to carry.
 *
 * The rule, stated once:
 *
 *   - `success` is the authority on whether the app reached the project
 *     space on THIS call.
 *   - `refusal` is why it did not, when it did not. It is the attempt's
 *     own report; the record deliberately does not carry it, because a
 *     refusal against an already-live deployment writes nothing durable.
 *   - `deployment` is the durable record for the target, absent when the
 *     app has never reached it. It explains where things stand, never
 *     whether this call worked.
 *   - The failure arm is for responses with none of that: a transport
 *     fault, or a 4xx from the route's own input and authorization gates.
 */

import type { DeploymentView } from "@/lib/deployment/actions";
import type {
	DeploymentAttemptRefusal,
	DeploymentConfirmationNeeded,
	DeploymentFailureCode,
	DeploymentRemoteChange,
	DeploymentResourceConflict,
} from "@/lib/deployment/types";
import { webAppsOffText } from "@/lib/publish/planFeatures";

/** The logo a landed publish offers for a person to add in CommCare HQ. */
export interface PublishLogoStepBody {
	readonly assetId: string;
	/** `logo<ext>`, the name the download is offered under. */
	readonly fileName: string;
	/** True when this is not the logo the deployment last offered. */
	readonly changed: boolean;
}

/** The parts of the publish response this decision reads. */
export interface PublishResponseBody {
	readonly success?: boolean;
	/**
	 * Which way the app landed: updated in place, or created fresh. The
	 * server decides from the deployment ledger; null on a refusal.
	 */
	readonly hq_app_action?: "created" | "updated" | null;
	/**
	 * The App Preview statement, on a publish that wrote over the app
	 * without knowing it unchanged; null on every other publish.
	 */
	readonly app_preview_note?: string | null;
	/**
	 * Whether Web Apps offers the app on the project space, as this publish
	 * read it back; null on a refusal, where nothing was read back.
	 */
	readonly web_apps_enabled?: boolean | null;
	/** The logo step a landed publish offers; null without a logo. */
	readonly logo_step?: PublishLogoStepBody | null;
	/**
	 * The HQ app's address. A refusal carries it too where the app is
	 * there, so a person can open it to change what stopped the publish.
	 */
	readonly url?: string | null;
	readonly warnings?: string[];
	readonly deployment?: DeploymentView["deployment"] | null;
	readonly setup_artifact?: DeploymentView["artifact"];
	readonly left_behind?: DeploymentView["leftBehind"];
	/** Why THIS attempt stopped, from the one publish lifecycle. */
	readonly refusal?: DeploymentAttemptRefusal | null;
	/**
	 * What Preview may honestly name for `commcare_project` now.
	 *
	 * Resolved by the server, which is the only side that can see whether
	 * this app is live on more than one project space, and therefore the
	 * only side that can apply the ambiguity rule. `null` means Preview
	 * names nothing.
	 */
	readonly preview_project_space?: string | null;
	readonly preflight?: readonly {
		readonly title: string;
		readonly status: string;
		readonly detail: string;
		readonly items?: readonly string[];
	}[];
	readonly error?: string;
}

export type PublishOutcome =
	| {
			readonly kind: "landed";
			/**
			 * The record the publish created or advanced. `success` is the
			 * authority on whether the app got there; the record only
			 * explains it, so a response that somehow carried none is still
			 * a success with nothing further to draw.
			 */
			readonly deployment: DeploymentView | null;
			/**
			 * Whether this publish updated the app the project space already
			 * held or created a fresh one. Null for a response that carried
			 * no answer, where the hero falls back to naming neither.
			 */
			readonly hqAppAction: "created" | "updated" | null;
			readonly appUrl: string;
			readonly warnings: string[];
			/** What Preview may name, per the server's ambiguity rule. */
			readonly previewProjectSpace: string | null;
			/**
			 * A line the landed outcome shows after a publish that wrote over
			 * the app without knowing it unchanged: after the person chose to
			 * publish over a change to the app in CommCare HQ, or over what
			 * the cutover read. Null on every other publish.
			 */
			readonly appPreviewNote: string | null;
			/**
			 * Whether Web Apps offers the app there, as this publish read it.
			 * Null for a response that carried no answer, where nothing is
			 * said about Web Apps.
			 */
			readonly webAppsEnabled: boolean | null;
			/** The logo step, for an app with a logo; null otherwise. */
			readonly logoStep: PublishLogoStepBody | null;
	  }
	| {
			readonly kind: "refused";
			/**
			 * The record for the target, when one exists. A first publish
			 * that never reached the project space has none, and the refusal
			 * below is the whole answer.
			 */
			readonly deployment: DeploymentView | null;
			readonly refusal: {
				/** Which stop it was, so the dialog can offer that stop's next step. */
				readonly code: DeploymentFailureCode;
				readonly message: string;
				readonly items: readonly string[];
			};
			/**
			 * The HQ app's address, where the app is there: the floor's stop
			 * sends the person to that app's settings. Null otherwise.
			 */
			readonly hqAppUrl: string | null;
			/**
			 * The resources on the target this publish would have written over
			 * and did not, because Nova did not create them. Empty for every
			 * other refusal. Naming them back is the only thing that changes
			 * the answer, so they travel structurally rather than as the prose
			 * `items` above.
			 */
			readonly resourceConflicts: readonly DeploymentResourceConflict[];
			/**
			 * What changed in CommCare HQ since Nova last published there,
			 * each with the state it was read in. Non-empty only for
			 * `hq_changed` at preflight; publishing over them means naming
			 * each one back with that state, so they travel structurally too.
			 */
			readonly remoteChanges: readonly DeploymentRemoteChange[];
			/**
			 * What a person has to confirm about the project space before the
			 * publish goes ahead. Non-empty only for `hq_confirmation_needed`;
			 * ticking each one and publishing again sends them back, so they
			 * travel structurally too.
			 */
			readonly confirmationsNeeded: readonly DeploymentConfirmationNeeded[];
			readonly warnings: string[];
			readonly previewProjectSpace: string | null;
	  }
	| {
			readonly kind: "failure";
			/**
			 * The blocked preflight edge, when the response named one.
			 * Present only on a 200 that carried checks but no refusal,
			 * which the route's own 4xx gates never produce. Left in
			 * because the shape is the route's to change, not this
			 * decision's to assume.
			 */
			readonly blockedDetail: string | undefined;
	  };

/**
 * The landed dialog's Web Apps line: said where the publish read Web Apps
 * as off for the app, naming the project space the publish went to. It is
 * the request's own target, so the line stands whether or not the response
 * carried the deployment record. Null where Web Apps offers the app, or no
 * read gave an answer.
 */
export function landedWebAppsLine(
	webAppsEnabled: boolean | null,
	publishedDomain: string,
): string | null {
	return webAppsEnabled === false ? webAppsOffText(publishedDomain) : null;
}

export function publishOutcome(
	responseOk: boolean,
	body: PublishResponseBody,
): PublishOutcome {
	const deployment =
		responseOk &&
		body.deployment !== undefined &&
		body.deployment !== null &&
		body.setup_artifact !== undefined
			? {
					deployment: body.deployment,
					artifact: body.setup_artifact,
					/* Defaulted rather than required: only the server can tell a
					 * rename from a recreate, so a response without the field
					 * reports nothing left behind instead of the client guessing
					 * from `superseded` and naming tables that are not there. */
					leftBehind: body.left_behind ?? [],
				}
			: null;
	if (responseOk && body.success === true) {
		return {
			kind: "landed",
			deployment,
			hqAppAction: body.hq_app_action ?? null,
			appUrl: body.url ?? "",
			warnings: body.warnings ?? [],
			previewProjectSpace: body.preview_project_space ?? null,
			appPreviewNote: body.app_preview_note ?? null,
			webAppsEnabled: body.web_apps_enabled ?? null,
			logoStep: body.logo_step ?? null,
		};
	}
	if (responseOk && body.refusal !== undefined && body.refusal !== null) {
		return {
			kind: "refused",
			deployment,
			refusal: {
				code: body.refusal.failure.code,
				message: body.refusal.failure.message,
				items: body.refusal.failure.details,
			},
			hqAppUrl: body.url || null,
			/* Defaulted rather than required: a response from a server that
			 * predates one of these fields is a refusal with nothing to take over or
			 * publish over, not a crash. */
			resourceConflicts: body.refusal.resourceConflicts ?? [],
			remoteChanges: body.refusal.remoteChanges ?? [],
			confirmationsNeeded: body.refusal.confirmationsNeeded ?? [],
			warnings: body.warnings ?? [],
			previewProjectSpace: body.preview_project_space ?? null,
		};
	}
	return {
		kind: "failure",
		blockedDetail: body.preflight?.find((check) => check.status === "blocked")
			?.detail,
	};
}
