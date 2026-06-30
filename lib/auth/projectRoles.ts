// Project (organization) roles + access control — the single source of the
// custom role taxonomy for Nova's "Projects" tenancy, imported by BOTH the
// server (`lib/auth.ts`) and the client (`lib/auth-client.ts`) so the two
// can't drift. Import-light (only Better Auth's access helpers — no DB, no MCP
// graph) so it's safe in the browser bundle, same discipline as
// `lib/db/creditPolicy.ts` and `lib/auth-public.ts`.
//
// "Project" is the product noun; the underlying Better Auth primitive is an
// `organization` and its tables stay `auth_organization*` (see
// `lib/auth-schema-shared.ts`). Teams + dynamic access control are OFF — flat
// Projects with these four static roles.
//
// The `app` resource governs app-level capability (view / edit / delete a
// shared app). Member + invitation + organization management ride Better
// Auth's built-in statements (granted to admin/owner via `adminAc`/`ownerAc`),
// so they are NOT duplicated as `app` actions.

import { createAccessControl } from "better-auth/plugins/access";
import {
	adminAc,
	defaultStatements,
	ownerAc,
} from "better-auth/plugins/organization/access";

/**
 * Access-control statement. `defaultStatements` carries the built-in
 * organization / member / invitation resources; we add the Nova-specific
 * `app` resource. `as const` is required for Better Auth's permission-type
 * inference.
 */
export const statement = {
	...defaultStatements,
	app: ["view", "edit", "delete"],
} as const;

export const ac = createAccessControl(statement);

/** Read-only: open and preview the Project's apps, no edits. */
export const viewer = ac.newRole({ app: ["view"] });
/** Edit the Project's apps; no member management. */
export const editor = ac.newRole({ app: ["view", "edit"] });
/** Edit + delete apps, and manage members/invitations. */
export const admin = ac.newRole({
	app: [...statement.app],
	...adminAc.statements,
});
/** Everything an admin can do, plus update/delete the Project itself. */
export const owner = ac.newRole({
	app: [...statement.app],
	...ownerAc.statements,
});
/**
 * Safety net for Better Auth's defaults: the `member` table's `role` column
 * defaults to "member", and the plugin's built-in `member` role grants ZERO
 * permissions on our custom `app` resource — a row left at that default would
 * be locked out of even viewing shared apps. Alias `member` to read-only so the
 * default is safe; the UI only ever offers viewer/editor/admin/owner.
 */
export const member = ac.newRole({ app: ["view"] });

export const PROJECT_ROLES = { member, viewer, editor, admin, owner } as const;
export type ProjectRole = keyof typeof PROJECT_ROLES;

/** App-level capabilities gated by the `app` resource. */
export type AppCapability = (typeof statement)["app"][number];

/**
 * Whether a member's stored role grants an app capability. The role string may
 * be comma-joined (Better Auth allows multiple roles per member), so any
 * granting role wins. Derives the answer from the AC role definitions — the
 * single source of truth — rather than a parallel capability table.
 */
export function roleAllowsApp(
	role: string,
	capability: AppCapability,
): boolean {
	return role
		.split(",")
		.some(
			(r) =>
				PROJECT_ROLES[r as ProjectRole]?.authorize({ app: [capability] })
					.success ?? false,
		);
}

/**
 * Whether a member's role may manage the Project's membership — invite, change
 * roles, remove members, cancel invitations. Admin and owner only; the plugin
 * enforces the same via the built-in `member`/`invitation` statements those two
 * roles carry, so this is the UI's matching gate (the wire stays the authority).
 */
export function roleCanManageProject(role: string): boolean {
	const parts = role.split(",");
	return parts.includes("admin") || parts.includes("owner");
}

/**
 * Whether a member's role is the Project owner — the one member who can't be
 * removed or re-roled (Better Auth reserves that to owners). NOT the move-out gate
 * (that's the `delete` capability, admin OR owner); this identifies the owner for
 * the move's owner-PROTECTION rule: the caller-is-source-owner check (an owner may
 * relocate their own app anywhere) and the home-page filter that reserves
 * personal-Project destinations to source owners. `role` may be comma-joined
 * (Better Auth allows multiple roles).
 */
export function roleIsOwner(role: string): boolean {
	return role.split(",").includes("owner");
}

/** Max members per Project (Better Auth's own default is 100). */
export const MEMBERSHIP_LIMIT = 200;
