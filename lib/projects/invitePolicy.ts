// lib/projects/invitePolicy.ts
//
// Who a Project invitation may target. Belt-and-suspenders over the
// sign-in allowlist (`lib/auth.ts`): a non-allowlisted invitee could
// never accept anyway (they can't sign in), but rejecting the invite up
// front keeps the members UI honest and the audit clean. Enforced
// server-side by the org plugin's `beforeCreateInvitation` hook.

// The single source for the dimagi-domain allowlist: `lib/auth.ts` derives
// the sign-in `ALLOWED_EMAIL_DOMAINS` set from this, so the invite gate and
// the sign-in gate can't drift. Lowercase (the matchers lowercase the input).
export const INVITE_ALLOWED_DOMAINS: readonly string[] = Object.freeze([
	"dimagi.com",
	"dimagi-ai.com",
]);

/**
 * Whether `email`'s domain is invitable. Case-insensitive, exact match
 * on the domain part (no subdomain widening) — `@dimagi.com` yes,
 * `@evil-dimagi.com` no.
 */
export function isInvitableEmail(email: string): boolean {
	const at = email.lastIndexOf("@");
	if (at === -1) return false;
	const domain = email.slice(at + 1).toLowerCase();
	return INVITE_ALLOWED_DOMAINS.includes(domain);
}
