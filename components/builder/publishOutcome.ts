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

import { sameConfirmationKey } from "@/components/builder/app-setup/publishingSectionModel";
import type { PreviewTargetFacts } from "@/lib/collab/previewTargetFactsFrame";
import type { DeploymentView } from "@/lib/deployment/actions";
import type {
	DeploymentAttemptRefusal,
	DeploymentConfirmationKey,
	DeploymentConfirmationNeeded,
	DeploymentFailureCode,
	DeploymentRemoteChange,
	DeploymentResourceConflict,
	PreviewDeploymentAnswer,
	PublishPlacements,
} from "@/lib/deployment/types";
import {
	type AcceptPlacementMoves,
	type PlacementMoveOfferView,
	SAME_TYPE_CHILD_LINKS_OFFER_HEADING,
	SAVE_TO_CASE_OFFER_HEADING,
	sameTypeChildLinksOfferBody,
	saveToCaseOfferBody,
} from "@/lib/publish/placementMoves";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import type { WebAppsChange } from "@/lib/publish/webApps";

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
	/** The settings the project space keeps in CommCare HQ, with their date, or null. */
	readonly kept?: DeploymentView["kept"];
	/** Why THIS attempt stopped, from the one publish lifecycle. */
	readonly refusal?: DeploymentAttemptRefusal | null;
	/**
	 * Where CommCare HQ keeps the app's case changes, as this attempt
	 * recorded it: how many placements it recorded and how many of them an
	 * accepted move offer moved. Both 0 where it recorded nothing.
	 */
	readonly placements?: PublishPlacements;
	/**
	 * What Preview may honestly name for `commcare_project` now.
	 *
	 * Resolved by the server, which is the only side that can see whether
	 * this app is live on more than one project space, and therefore the
	 * only side that can apply the ambiguity rule. `null` means Preview
	 * names nothing. Absent, with `preview_target_facts`, where the server
	 * could not read the answer after the publish.
	 */
	readonly preview_project_space?: string | null;
	/**
	 * What that one project space keeps of the settings Preview plays, under
	 * the same rule. `null` means Preview holds no facts.
	 */
	readonly preview_target_facts?: PreviewTargetFacts | null;
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
			/** What Preview may name and play, per the server's ambiguity rule; `null` where the response carried no answer. */
			readonly preview: PreviewDeploymentAnswer | null;
			/**
			 * A line the landed outcome shows after a publish that wrote over
			 * the app without knowing it unchanged: after the person chose to
			 * publish over a change to the app in CommCare HQ, or over what
			 * the cutover read. Null on every other publish.
			 */
			readonly appPreviewNote: string | null;
			/** The logo step, for an app with a logo; null otherwise. */
			readonly logoStep: PublishLogoStepBody | null;
			/** What this publish recorded of where CommCare HQ keeps its case changes. */
			readonly placements: PublishPlacements;
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
			 * sends the person to that app's settings, and a build profile's
			 * stop to its Releases page. Null otherwise.
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
			/**
			 * The Web Apps question, for `hq_web_apps_change`: the change the
			 * publish would make to the app's Web App setting. Null otherwise.
			 */
			readonly webAppsChange: WebAppsChange | null;
			/**
			 * The case changes Nova can move so the project space can take the
			 * app, which a person accepts by ticking one box and publishing
			 * again; null where the refusal offers none.
			 */
			readonly placementMoves: PlacementMoveOfferView | null;
			/**
			 * What the attempt recorded before it stopped. A refusal after an
			 * accepted offer can already have moved the changes (`moved > 0`),
			 * so the next publish starts from the app as it holds them now.
			 */
			readonly placements: PublishPlacements;
			readonly warnings: string[];
			readonly preview: PreviewDeploymentAnswer | null;
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
 * Whether a refusal's way forward is on the app's own page in CommCare HQ,
 * so the dialog offers "Open the app in CommCare HQ" beside it: the
 * CommCare version is raised in the app's settings, and an application
 * profile is changed on its Releases page, which `hqAppUrl` opens.
 */
export function refusalOpensHqApp(code: DeploymentFailureCode): boolean {
	return (
		code === "hq_app_version_below_floor" ||
		code === "hq_build_profile_language_missing"
	);
}

/**
 * What a response says Preview may name and play, or `null` where it carries
 * neither half: the server could not read the answer after the publish, so
 * the tab keeps what it holds. One half alone reads the other as `null`.
 */
function previewAnswerOf(
	body: PublishResponseBody,
): PreviewDeploymentAnswer | null {
	if (
		body.preview_project_space === undefined &&
		body.preview_target_facts === undefined
	) {
		return null;
	}
	return {
		projectSpace: body.preview_project_space ?? null,
		targetFacts: body.preview_target_facts ?? null,
	};
}

/** What a response that names no placements recorded: nothing. */
const NO_PLACEMENTS: PublishPlacements = { recorded: 0, moved: 0 };

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
					/* Absent reads as no kept list, which draws nothing. */
					kept: body.kept ?? null,
				}
			: null;
	if (responseOk && body.success === true) {
		return {
			kind: "landed",
			deployment,
			hqAppAction: body.hq_app_action ?? null,
			appUrl: body.url ?? "",
			warnings: body.warnings ?? [],
			preview: previewAnswerOf(body),
			appPreviewNote: body.app_preview_note ?? null,
			logoStep: body.logo_step ?? null,
			placements: body.placements ?? NO_PLACEMENTS,
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
			webAppsChange: body.refusal.webAppsChange ?? null,
			placementMoves: body.refusal.placementMoves ?? null,
			placements: body.placements ?? NO_PLACEMENTS,
			warnings: body.warnings ?? [],
			preview: previewAnswerOf(body),
		};
	}
	return {
		kind: "failure",
		blockedDetail: body.preflight?.find((check) => check.status === "blocked")
			?.detail,
	};
}

/**
 * The words of an offer to move case changes: a heading and a body above the
 * move sentences. The `same-type-child-links` body says what the refusal's
 * compatibility report found for that capability, so it needs the report; a
 * report that holds the capability neither missing nor unverified gives it
 * nothing true to say, and the dialog then does not offer it.
 */
export function placementOfferCopy(
	offer: PlacementMoveOfferView,
	report: ProjectSpaceCompatibilityReport | undefined,
): { readonly heading: string; readonly body: string } | null {
	switch (offer.reason) {
		case "save-to-case":
			return {
				heading: SAVE_TO_CASE_OFFER_HEADING,
				body: saveToCaseOfferBody(offer.asksChildCases),
			};
		case "same-type-child-links": {
			const state = report?.required_capabilities.find(
				(capability) => capability.id === "same-type-child-links",
			)?.state;
			return state === "missing" || state === "unverified"
				? {
						heading: SAME_TYPE_CHILD_LINKS_OFFER_HEADING,
						body: sameTypeChildLinksOfferBody(state),
					}
				: null;
		}
	}
}

/** Whether a confirmation is the plan's Save to Case, which a
 *  `save-to-case` move makes unnecessary. */
function isSaveToCaseConfirmation(key: DeploymentConfirmationKey): boolean {
	return key.kind === "plan-feature" && key.subject === "advanced-case-actions";
}

/**
 * What the person has answered for the next publish: the project-space
 * confirmations they ticked and the move offer they accepted.
 *
 * A `save-to-case` move and "This project space has it" for Save to Case
 * answer one question two ways (move the changes so the plan needn't have
 * it, or say the plan has it), so ticking one unticks the other.
 */
export interface PublishAnswers {
	readonly confirmations: readonly DeploymentConfirmationKey[];
	readonly acceptMoves: AcceptPlacementMoves | null;
}

/** The answers once a confirmation is ticked or unticked. */
export function withConfirmation(
	answers: PublishAnswers,
	key: DeploymentConfirmationKey,
	confirmed: boolean,
): PublishAnswers {
	const rest = answers.confirmations.filter(
		(entry) => !sameConfirmationKey(entry, key),
	);
	return {
		confirmations: confirmed ? [...rest, key] : rest,
		acceptMoves:
			confirmed &&
			isSaveToCaseConfirmation(key) &&
			answers.acceptMoves?.reason === "save-to-case"
				? null
				: answers.acceptMoves,
	};
}

/** The answers once an offer's box is ticked or unticked. */
export function withAcceptedMoves(
	answers: PublishAnswers,
	offer: PlacementMoveOfferView,
	accepted: boolean,
): PublishAnswers {
	if (!accepted) return { ...answers, acceptMoves: null };
	return {
		confirmations:
			offer.reason === "save-to-case"
				? answers.confirmations.filter(
						(entry) => !isSaveToCaseConfirmation(entry),
					)
				: answers.confirmations,
		acceptMoves: { reason: offer.reason, digest: offer.digest },
	};
}

/** Whether the accepted answer is this offer, as it was shown. */
export function acceptsOffer(
	acceptMoves: AcceptPlacementMoves | null,
	offer: PlacementMoveOfferView,
): boolean {
	return (
		acceptMoves !== null &&
		acceptMoves.reason === offer.reason &&
		acceptMoves.digest === offer.digest
	);
}

/**
 * The confirmation keys a publish still waits on: every one asked, except
 * Save to Case once a `save-to-case` move is accepted, since the move is
 * what lets the publish go without it.
 */
export function confirmationsStillAsked<
	T extends { readonly key: DeploymentConfirmationKey },
>(requests: readonly T[], acceptMoves: AcceptPlacementMoves | null): T[] {
	return acceptMoves?.reason === "save-to-case"
		? requests.filter((request) => !isSaveToCaseConfirmation(request.key))
		: [...requests];
}
