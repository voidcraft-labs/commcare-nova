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
 *     space. The record is what EXPLAINS the outcome, either way.
 *   - A refusal that came with a record is shown as a refusal, not as a
 *     generic failure box.
 *   - The failure box is for the cases with nothing to show: a transport
 *     fault, a 4xx from the route's own input and authorization checks, or
 *     a refusal that arrived without a record.
 */

import type { DeploymentView } from "@/lib/deployment/actions";

/** The parts of the publish response this decision reads. */
export interface PublishResponseBody {
	readonly success?: boolean;
	readonly url?: string;
	readonly warnings?: string[];
	readonly deployment?: DeploymentView["deployment"];
	readonly setup_artifact?: DeploymentView["artifact"];
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
			readonly kind: "record";
			/** Whether the app actually reached the project space. */
			readonly landed: boolean;
			readonly deployment: DeploymentView | undefined;
			readonly appUrl: string;
			readonly warnings: string[];
			/** What Preview may name, per the server's ambiguity rule. */
			readonly previewProjectSpace: string | null;
			/**
			 * Why this attempt did not get there, when it did not.
			 *
			 * Needed separately from the record: a publish blocked against an
			 * app that is ALREADY live leaves the record untouched and green,
			 * so the record carries no failure to explain the refusal. This
			 * is the blocked preflight edge, which does.
			 */
			readonly blocked:
				| { readonly detail: string; readonly items: readonly string[] }
				| undefined;
	  }
	| {
			readonly kind: "failure";
			/**
			 * The blocked preflight edge, when the response named one.
			 *
			 * Present only on a 200 that carried checks but no record, which
			 * a 4xx from the route's own input and authorization gates never
			 * does. Left in because the shape is the route's to change, not
			 * this decision's to assume.
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
		body.setup_artifact !== undefined
			? { deployment: body.deployment, artifact: body.setup_artifact }
			: undefined;
	const landed = responseOk && body.success === true;
	if (!landed && deployment === undefined) {
		return {
			kind: "failure",
			blockedDetail: body.preflight?.find((check) => check.status === "blocked")
				?.detail,
		};
	}
	const blockedCheck = body.preflight?.find(
		(check) => check.status === "blocked",
	);
	return {
		kind: "record",
		landed,
		deployment,
		appUrl: body.url ?? "",
		warnings: body.warnings ?? [],
		previewProjectSpace: body.preview_project_space ?? null,
		blocked:
			landed || blockedCheck === undefined
				? undefined
				: { detail: blockedCheck.detail, items: blockedCheck.items ?? [] },
	};
}
