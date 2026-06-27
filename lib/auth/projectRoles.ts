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
	app: ["view", "edit", "delete"],
	...adminAc.statements,
});
/** Everything an admin can do, plus update/delete the Project itself. */
export const owner = ac.newRole({
	app: ["view", "edit", "delete"],
	...ownerAc.statements,
});

export const PROJECT_ROLES = { viewer, editor, admin, owner } as const;
export type ProjectRole = keyof typeof PROJECT_ROLES;

/** App-level capabilities gated by the `app` resource. */
export type AppCapability = (typeof statement)["app"][number];

/** Max members per Project (Better Auth's own default is 100). */
export const MEMBERSHIP_LIMIT = 200;
