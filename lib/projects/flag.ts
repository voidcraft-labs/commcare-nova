// lib/projects/flag.ts
//
// `PROJECTS_ENABLED` — the master flag for the shared-Projects feature
// (the Projects UI: switcher, members/roles, invitations, and the
// Better-Auth organization HTTP endpoints that back them).
//
// Default OFF. The whole tenancy + per-actor-billing foundation (P0–P5)
// ships dark behind this: every user still gets an auto-provisioned
// personal Project and all reads/writes are Project-scoped, but the
// SHARING surface stays unreachable until the flag flips — the org
// management endpoints are in `disabledPaths` (lib/auth.ts) and the UI
// affordances render nothing. Flipping the flag is what turns a
// single-member-per-Project deployment into a collaborative one.
//
// `NEXT_PUBLIC_` so the same value reads identically on the server (the
// auth config, Server Actions) and in the client bundle (the switcher /
// members UI), with no drift between the two halves of a gate.

export const PROJECTS_ENABLED =
	process.env.NEXT_PUBLIC_PROJECTS_ENABLED === "true";

/**
 * The email domains a Project invitation may target. Belt-and-suspenders
 * over the sign-in allowlist (`lib/auth.ts`): a non-allowlisted invitee
 * could never accept anyway (they can't sign in), but rejecting the
 * invite up front keeps the members UI honest and the audit clean. Kept
 * here next to the flag so the Projects feature owns its own policy.
 */
export const INVITE_ALLOWED_DOMAINS = ["dimagi.com", "dimagi-ai.com"];

/**
 * Whether `email`'s domain is invitable. Case-insensitive, exact-suffix
 * match on the domain part (no subdomain widening) — `@dimagi.com` yes,
 * `@evil-dimagi.com` no.
 */
export function isInvitableEmail(email: string): boolean {
	const at = email.lastIndexOf("@");
	if (at === -1) return false;
	const domain = email.slice(at + 1).toLowerCase();
	return INVITE_ALLOWED_DOMAINS.includes(domain);
}
