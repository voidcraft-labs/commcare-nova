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
	| "not_permitted";

export class DeploymentError extends Error {
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

/** The one not-found message every ambiguous case shares. */
export function deploymentNotFound(): DeploymentError {
	return new DeploymentError(
		"not_found",
		"That deployment isn't available. It may have been removed, the app may have moved to another project, or you may no longer have access to it.",
	);
}
