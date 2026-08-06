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
	 * The remote resource is already mapped to a different Nova resource, or
	 * to this one under different ownership. Its own code because the
	 * recovery is specific: look at what already owns it, do not overwrite.
	 */
	| "already_mapped";

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

/** The one not-found message every ambiguous case shares. */
export function deploymentNotFound(): DeploymentError {
	return new DeploymentError(
		"not_found",
		"That deployment isn't available. It may have been removed, the app may have moved to another project, or you may no longer have access to it.",
	);
}
