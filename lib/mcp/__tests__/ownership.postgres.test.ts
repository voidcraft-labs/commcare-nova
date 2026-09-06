import { sql } from "kysely";
import { expect, it } from "vitest";
import type { AppCapability } from "@/lib/auth/projectRoles";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { resolveAppScope } from "@/lib/db/appAccess";
import { restoreApp, softDeleteApp } from "@/lib/db/apps";
import { loadAppBlueprint } from "../loadApp";
import { requireProjectAccess } from "../ownership";

const h = setupAppStateTestDb("mcp_access_", { authSchema: "migrated" });
const PROJECT = "access-project";
const ACTOR = "creator";
it("uses current membership and forwards every requested capability, without an app-owner bypass", async () => {
	const app = await h.seedApp({ owner: ACTOR, project_id: PROJECT });
	const cases = [
		{ role: "viewer", allowed: ["view"] },
		{ role: "editor", allowed: ["view", "edit"] },
		{ role: "admin", allowed: ["view", "edit", "delete"] },
		{ role: "owner", allowed: ["view", "edit", "delete"] },
	] as const;
	for (const { role, allowed } of cases) {
		await h.seedProjectMember(ACTOR, PROJECT, role);
		for (const capability of [
			"view",
			"edit",
			"delete",
		] satisfies AppCapability[]) {
			if ((allowed as readonly string[]).includes(capability)) {
				await expect(
					loadAppBlueprint(app, ACTOR, capability),
				).resolves.toMatchObject({
					access: { projectId: PROJECT, actorUserId: ACTOR, role },
				});
				await expect(
					requireProjectAccess(ACTOR, PROJECT, capability),
				).resolves.toEqual({ projectId: PROJECT, role, actorUserId: ACTOR });
			} else {
				await expect(
					loadAppBlueprint(app, ACTOR, capability),
				).rejects.toMatchObject({
					name: "McpAccessError",
					reason: "not_owner",
					resource: "app",
				});
				await expect(
					requireProjectAccess(ACTOR, PROJECT, capability, "Ask an admin."),
				).rejects.toMatchObject({
					name: "ProjectPermissionError",
					message: "Ask an admin.",
				});
			}
		}
	}
	await sql`DELETE FROM auth_member WHERE "userId" = ${ACTOR} AND "organizationId" = ${PROJECT}`.execute(
		h.db(),
	);
	await expect(loadAppBlueprint(app, ACTOR)).rejects.toMatchObject({
		reason: "not_owner",
		resource: "app",
	});
	await expect(
		requireProjectAccess(ACTOR, PROJECT, "view"),
	).rejects.toMatchObject({ reason: "not_owner", resource: "project" });
});
it("scopes memberships by both actor and Project, and distinguishes missing resources only internally", async () => {
	const app = await h.seedApp({ owner: ACTOR, project_id: PROJECT });
	await h.seedProjectMember("other-user", PROJECT, "owner");
	await h.seedProjectMember("outsider", "other-project", "owner");
	await expect(loadAppBlueprint(app, "outsider")).rejects.toMatchObject({
		reason: "not_owner",
		resource: "app",
	});
	await expect(
		requireProjectAccess("outsider", PROJECT, "view"),
	).rejects.toMatchObject({ reason: "not_owner", resource: "project" });
	await expect(loadAppBlueprint("missing-app", ACTOR)).rejects.toMatchObject({
		reason: "not_found",
		resource: "app",
	});
	await expect(
		requireProjectAccess(ACTOR, "missing-project", "view"),
	).rejects.toMatchObject({ reason: "not_found", resource: "project" });
});
it.each([
	{
		name: "full MCP blueprint",
		read: (app: string, user: string) => loadAppBlueprint(app, user),
	},
	{
		name: "lightweight route scope",
		read: (app: string, user: string) => resolveAppScope(app, user),
	},
])(
	"$name allows default view access, refuses a deleted app and allows it after restore",
	async ({ read }) => {
		const app = await h.seedApp({ owner: ACTOR, project_id: PROJECT });
		await h.seedProjectMember("co-member", PROJECT, "viewer");
		await expect(read(app, "co-member")).resolves.toBeDefined();
		await softDeleteApp(app, ACTOR);
		for (const user of [ACTOR, "co-member"]) {
			await expect(read(app, user)).rejects.toMatchObject({
				reason: "not_found",
			});
		}
		// The Project still exists and its members retain access to other apps.
		await expect(
			requireProjectAccess("co-member", PROJECT, "view"),
		).resolves.toMatchObject({ role: "viewer" });
		await restoreApp(app, ACTOR);
		await expect(read(app, "co-member")).resolves.toBeDefined();
	},
);
