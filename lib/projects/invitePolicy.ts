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

// ── Personal-Project role cap ───────────────────────────────────────
//
// A personal Project is the user's own auto-provisioned solo space. Granting a
// guest `admin` (member management) or `owner` makes no sense there, so invites
// and role changes on a personal Project are capped to viewer/editor. Shared
// Projects allow the full set. Enforced server-side by the org plugin's
// `beforeCreateInvitation` + `beforeUpdateMemberRole` hooks (`lib/auth.ts`); the
// members UI mirrors it (hides admin when the Project is personal).

/** Roles assignable on a personal Project. */
export const PERSONAL_PROJECT_ROLES: readonly string[] = Object.freeze([
	"viewer",
	"editor",
]);

/** Wire-and-UI message when a personal Project is asked for a capped role. */
export const PERSONAL_PROJECT_ROLE_ERROR =
	"A personal Project can only be shared at viewer or editor — admin and owner aren't available for it.";

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

/**
 * Whether assigning `role` is allowed on a personal Project. `role` may be a
 * single slug, a comma-joined string, or an array (Better Auth permits multiple
 * roles per member); EVERY part must be in {@link PERSONAL_PROJECT_ROLES}. An
 * empty/malformed role is left for Better Auth's own validation (treated as
 * allowed here so this cap doesn't mask a different error).
 */
export function isRoleAllowedOnPersonalProject(
	role: string | string[],
): boolean {
	return (Array.isArray(role) ? role : [role])
		.flatMap((r) => r.split(","))
		.map((r) => r.trim())
		.filter(Boolean)
		.every((r) => PERSONAL_PROJECT_ROLES.includes(r));
}
