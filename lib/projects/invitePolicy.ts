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

// ── Personal Projects are private ───────────────────────────────────
//
// A personal Project is the user's own auto-provisioned solo space. It is
// private and accepts no members but its owner — invitations and role changes
// on it are rejected outright. To collaborate while cross-Project app moves are
// unavailable, a user creates or switches to a shared Project and builds the team
// app there. Enforced server-side by the org plugin's
// `beforeCreateInvitation` + `beforeUpdateMemberRole` hooks (`lib/auth.ts`); the
// members UI reflects it (a personal Project renders a read-only "can't be
// shared" panel instead of the invite form).

/** Wire-and-UI message when an invitation or role change targets a personal
 * Project. It points to the currently available collaboration path without
 * promising the temporarily blocked cross-Project move. */
export const PERSONAL_PROJECT_NOT_SHAREABLE_ERROR =
	"Your personal Project is private and can't be shared. Create or switch to a shared Project to build apps with teammates.";

/**
 * Whether a Project's stored metadata marks it the user's auto-provisioned
 * personal Project. Tolerates `metadata` as a parsed object (the shape Better
 * Auth hands its hooks) OR a JSON string (the raw column), and returns `false`
 * on anything absent or malformed.
 */
export function isPersonalProjectMetadata(metadata: unknown): boolean {
	let parsed: unknown = metadata;
	if (typeof metadata === "string") {
		try {
			parsed = JSON.parse(metadata);
		} catch {
			return false;
		}
	}
	return (
		typeof parsed === "object" &&
		parsed !== null &&
		(parsed as { personal?: unknown }).personal === true
	);
}
