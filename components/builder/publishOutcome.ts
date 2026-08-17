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
import type { DeploymentAttemptRefusal } from "@/lib/deployment/types";

/** The parts of the publish response this decision reads. */
export interface PublishResponseBody {
	readonly success?: boolean;
	/**
	 * Which way the app landed: updated in place, or created fresh. The
	 * server decides from the deployment ledger; null on a refusal.
	 */
	readonly hq_app_action?: "created" | "updated" | null;
	readonly url?: string;
	readonly warnings?: string[];
	readonly deployment?: DeploymentView["deployment"] | null;
	readonly setup_artifact?: DeploymentView["artifact"];
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
				readonly message: string;
				readonly items: readonly string[];
			};
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

export function publishOutcome(
	responseOk: boolean,
	body: PublishResponseBody,
): PublishOutcome {
	const deployment =
		responseOk &&
		body.deployment !== undefined &&
		body.deployment !== null &&
		body.setup_artifact !== undefined
			? { deployment: body.deployment, artifact: body.setup_artifact }
			: null;
	if (responseOk && body.success === true) {
		return {
			kind: "landed",
			deployment,
			hqAppAction: body.hq_app_action ?? null,
			appUrl: body.url ?? "",
			warnings: body.warnings ?? [],
			previewProjectSpace: body.preview_project_space ?? null,
		};
	}
	if (responseOk && body.refusal !== undefined && body.refusal !== null) {
		return {
			kind: "refused",
			deployment,
			refusal: {
				message: body.refusal.failure.message,
				items: body.refusal.failure.details,
			},
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
