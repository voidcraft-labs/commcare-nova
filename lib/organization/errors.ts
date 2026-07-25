// lib/organization/errors.ts
//
// Expected rejections from the locations store. Infrastructure failures stay
// unwrapped so an operational fault is never reported to an author as
// something they can fix.

import type { OrganizationRevision } from "./types";

export type OrganizationErrorCode =
	/** Missing, or in a Project the caller cannot see. Deliberately one code. */
	| "not_found"
	| "forbidden"
	/** The organization changed since the caller read it. */
	| "conflict"
	/** The input itself is not a legal organization state. */
	| "invalid"
	/** A structural rule about the tree, named in the message. */
	| "rejected"
	/** The app already holds as many places as Nova stores. */
	| "limit";

/**
 * An expected service-layer rejection.
 *
 * `not_found` covers a missing app, a missing place, and a place in an app
 * whose Project the caller is not a member of — one shape for all three,
 * because a distinguishable "exists but not yours" confirms a resource in a
 * Project the caller cannot see. An insufficient role collapses here too.
 */
export class OrganizationError extends Error {
	readonly name = "OrganizationError";
	readonly code: OrganizationErrorCode;
	readonly currentRevision?: OrganizationRevision;

	constructor(
		code: OrganizationErrorCode,
		message: string,
		options: { cause?: unknown; currentRevision?: OrganizationRevision } = {},
	) {
		super(message, { cause: options.cause });
		this.code = code;
		this.currentRevision = options.currentRevision;
	}
}

/** The one not-found message every ambiguous case shares. */
export function organizationNotFound(): OrganizationError {
	return new OrganizationError(
		"not_found",
		"That place isn't in this app's organization. It may have been removed, or you may not have access to this app.",
	);
}
