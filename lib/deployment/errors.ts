// lib/deployment/errors.ts
//
// Expected rejections from the deployment store. Infrastructure failures
// stay unwrapped, so an operational fault is never handed to an author as
// something they can fix.
//
// A phase that fails against CommCare HQ is NOT one of these. That is an
// ordinary recorded outcome on the deployment, which is the whole point of
// keeping the record: "CommCare HQ refused the upload" is durable state
// somebody retries, not an exception the caller swallows.

export type DeploymentErrorCode =
	/**
	 * Missing, or in a Project the caller cannot see. Deliberately one code:
	 * a distinguishable "exists but not yours" would confirm a deployment on
	 * a project space the caller has no business knowing about.
	 */
	| "not_found"
	/** The input is not a legal deployment target or resource identity. */
	| "invalid"
	/**
	 * No CommCare HQ connection on this account. Its own code so every
	 * surface can emit the tag its clients already branch on, rather than
	 * flattening it into a generic invalid input.
	 */
	| "hq_not_connected"
	/** The caller's key cannot reach this project space. */
	| "domain_not_authorized"
	/**
	 * The caller can see and edit the deployment and may not do this to it.
	 * Its message names who may.
	 */
	| "not_permitted"
	/**
	 * The request named a state of the deployment it no longer stands at (a
	 * stop naming an HQ app the deployment no longer publishes to), and
	 * nothing was written. Its message says to look again.
	 */
	| "stale";

export class DeploymentError extends Error {
	/* Every subclass keeps this name, so a surface that matches by name
	 * (`lib/apiError.ts`) answers it as the code it carries. */
	readonly name = "DeploymentError";
	readonly code: DeploymentErrorCode;

	constructor(
		code: DeploymentErrorCode,
		message: string,
		options: { cause?: unknown } = {},
	) {
		super(message, { cause: options.cause });
		this.code = code;
	}
}

/** The request's credential no longer authorizes any new deployment work. */
export class DeploymentCredentialInactiveError extends DeploymentError {
	constructor(message: string, options?: { cause?: unknown }) {
		super("not_permitted", message, options);
	}
}

/**
 * A store write found the deployment ended since its publish first read it.
 * Never shown to a person: `publishAppToHq` and `service.ts::refreshKeptValues`
 * catch it and answer that publishing there stopped, and
 * `workers.ts::provisionWorkers` catches it and records no worker mapping.
 * It is no `DeploymentError` and carries no code.
 */
export class DeploymentEndedError extends Error {
	readonly name = "DeploymentEndedError";

	constructor(
		readonly deploymentId: string,
		/** The count the writer was given. */
		readonly expectedEndings: number,
		/** The count the locked row holds. */
		readonly endings: number,
	) {
		super(
			`Deployment ${deploymentId} ended since its publish first read it: the publish read ${expectedEndings} endings and the row now holds ${endings}, so this write was refused.`,
		);
	}
}

/** What a read of a deleted app's deployments tells its member. */
export const APP_DELETED_READ =
	"This app was deleted, so Nova can't show where it's published. You can restore it from Recently deleted in your apps.";

/** What a write to a deleted app's deployments tells its member. */
export const APP_DELETED_WRITE =
	"This app was deleted, so Nova changed nothing about where it's published. You can restore it from Recently deleted in your apps.";

/**
 * The app is in recently deleted, said only to a caller who is still a member
 * of its Project with the capability the read or write asked for, so it
 * confirms nothing a stranger may not know. Made by the one authorization a
 * deployment read and a deployment write share
 * (`store.ts::authorizeDeploymentApp`); a caller that stopped partway says
 * what it did in its own words with `restated`, which keeps the class and so
 * the proof. It is a `not_found` to every surface that branches on the code;
 * a surface that says something of a deleted app reads the class.
 */
export class DeploymentAppDeletedError extends DeploymentError {
	constructor(message: string) {
		super("not_found", message);
	}

	/** The same answer, told in the words of the act it stopped. */
	restated(message: string): DeploymentAppDeletedError {
		return new DeploymentAppDeletedError(message);
	}
}

/**
 * What a publish tells a member whose app was deleted while it ran: nothing
 * sent, or what CommCare HQ may hold of what was. What each write made is
 * recorded on its admission either way; the attempt itself is not folded,
 * since the deployment belongs to an app in recently deleted.
 */
export function appDeletedWhilePublishing(
	domain: string,
	sentAnything: boolean,
): string {
	return sentAnything
		? `This app was deleted while it was being published to “${domain}”, so Nova stopped. CommCare HQ may hold part of what was already sent there, and Nova kept a record of it. You can restore the app from Recently deleted in your apps and publish again.`
		: `This app was deleted while Nova was getting it ready to publish to “${domain}”, so nothing was sent. You can restore it from Recently deleted in your apps and publish again.`;
}

/**
 * What a publish tells a publisher who can no longer publish the app (no
 * longer a member of its Project, or no longer allowed to edit it) once
 * something had gone to CommCare HQ: that it went and was recorded, and
 * nothing of the deployment they may no longer read.
 */
export function accessLostWhilePublishing(domain: string): string {
	return `Nova stopped publishing this app to “${domain}” because you can no longer publish it. CommCare HQ may hold part of what was already sent there, and Nova kept a record of it. Someone who can edit the app can publish it again.`;
}

/** The one not-found message every ambiguous case shares. */
export function deploymentNotFound(): DeploymentError {
	return new DeploymentError(
		"not_found",
		"That deployment isn't available. It may have been removed, the app may have moved to another project, or you may no longer have access to it.",
	);
}
