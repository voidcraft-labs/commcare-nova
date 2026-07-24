// lib/preview/engine/identity.ts
//
// ResolvedPreviewIdentity — the one identity contract every preview surface
// speaks: Search and Results session evaluation, form XPath `#user/*`, the
// SQL compiler's session bindings, and the acting user behind case writes
// all derive from a single resolved identity instead of ad-hoc projections.
//
// Providers are the only constructors of the type, and every provider must
// present a PERSISTED user id — the id that authorizes the actor and stamps
// `owner_id` on created rows. "Preview as me" is the sole provider today;
// named preview personas plug in as additional providers producing the same
// type once they have stable persisted identity. There is deliberately no
// way to construct a session-only pseudo-persona, and the contract exposes
// no device-geometry (`window_width`) or aggregate arms.
//
// Server Actions resolve the identity from the authenticated session at
// their own boundary and never accept one from the client; the client
// resolves the SAME projection from its Better Auth session purely for
// local expression evaluation and display.

import type { SessionContextField } from "@/lib/domain/predicate";

/**
 * The session slices a preview expression can read on the device: the
 * closed-namespace context fields and the open-namespace user-data map.
 *
 * User-data keys are ABSENT when the worker has no value — never coerced
 * to an empty string — preserving the wire's absent-node comparison split.
 * Each evaluation layer applies its own documented blank fallback where
 * the device would read an absent node as blank.
 */
export interface PreviewSearchSessionValues {
	readonly context: Readonly<Partial<Record<SessionContextField, string>>>;
	readonly user: Readonly<Record<string, string>>;
}

/** Narrow user shape shared by Better Auth's client and server session. */
export interface PreviewSessionUser {
	readonly id: string;
	readonly name?: string | null;
	readonly email?: string | null;
}

/**
 * One resolved identity for the whole preview runtime.
 *
 * `ownerId` is the persisted identity: the acting user for authorization
 * and the create-time `owner_id` stamp on real case rows. `session` is the
 * same identity projected into the CommCare session vocabulary that
 * authored expressions read.
 */
export interface ResolvedPreviewIdentity {
	readonly ownerId: string;
	readonly session: PreviewSearchSessionValues;
}

/**
 * The signed-out projection: device context only, no user values. This is
 * NOT an identity — it exists so client surfaces can evaluate session
 * expressions before hydration resolves the real session, reading every
 * user-backed slice as absent.
 */
const ANONYMOUS_SESSION_VALUES: PreviewSearchSessionValues = {
	context: {
		deviceid: "nova-preview",
		appversion: "preview",
	},
	user: {},
};

/**
 * The sole shipped provider: resolve the signed-in Nova user as the preview
 * identity. Refuses (returns `null`) without a persisted user id — the
 * seam future providers share, so nothing downstream ever handles an
 * unpersisted actor.
 *
 * `userid` is the important identity bridge: real case rows are owned by
 * that same authenticated id, so owner-scoped expressions behave truthfully
 * in preview. The open-namespace user map is necessarily best-effort; the
 * common profile fields are populated when present and an unknown custom
 * field resolves blank downstream, just as it would for a worker without
 * that user-data field.
 */
export function previewAsMe(
	user: PreviewSessionUser | null | undefined,
): ResolvedPreviewIdentity | null {
	if (user === null || user === undefined) return null;
	if (user.id.trim() === "") return null;

	const email = user.email?.trim() ?? "";
	const name = user.name?.trim() ?? "";
	const username = email || name || user.id;
	const nameParts = name.split(/\s+/).filter(Boolean);
	const firstName = nameParts[0] ?? "";
	const lastName = nameParts.slice(1).join(" ");

	return {
		ownerId: user.id,
		session: {
			context: {
				userid: user.id,
				username,
				deviceid: "nova-preview",
				appversion: "preview",
			},
			user: Object.fromEntries(
				[
					["userid", user.id],
					["username", username],
					["email", email],
					["name", name],
					["first_name", firstName],
					["last_name", lastName],
				].filter((entry): entry is [string, string] => entry[1] !== ""),
			),
		},
	};
}

/**
 * Project an identity — or its absence — into the session vocabulary
 * expression evaluation reads. `null` yields the anonymous projection.
 */
export function previewSessionValues(
	identity: ResolvedPreviewIdentity | null,
): PreviewSearchSessionValues {
	return identity?.session ?? ANONYMOUS_SESSION_VALUES;
}

/**
 * Material equality over the resolved identity — used to distinguish a
 * re-derived-but-identical identity (a session refetch minting new object
 * references) from a real identity change that must rebuild evaluation
 * state.
 */
export function samePreviewIdentity(
	a: ResolvedPreviewIdentity | null,
	b: ResolvedPreviewIdentity | null,
): boolean {
	if (a === null || b === null) return a === b;
	return (
		a.ownerId === b.ownerId &&
		sameStringRecord(a.session.context, b.session.context) &&
		sameStringRecord(a.session.user, b.session.user)
	);
}

function sameStringRecord(
	a: Readonly<Record<string, string | undefined>>,
	b: Readonly<Record<string, string | undefined>>,
): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	return (
		aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key])
	);
}
