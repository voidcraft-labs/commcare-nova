import { expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { deleteLookupTableAction } from "../actions";
import { LookupSchemaGovernanceError } from "../schemaGovernance";

const mocks = vi.hoisted(() => ({ govern: vi.fn() }));
vi.mock("@/lib/auth-utils", () => ({
	getSession: async () => ({ user: { id: "lookup-owner" } }),
}));
vi.mock("../schemaGovernance", async (importOriginal) => ({
	...(await importOriginal<typeof import("../schemaGovernance")>()),
	applyLookupSchemaGovernance: mocks.govern,
}));

const h = setupAppStateTestDb("lookup_action_names_");

it("names only requested blockers in the authorized Project, including trash, ordered by name", async () => {
	await h.seedApp({
		id: "active",
		project_id: "local",
		owner: "lookup-owner",
		app_name: "Zebra register",
	});
	await h.seedApp({
		id: "trashed",
		project_id: "local",
		app_name: "Archived register",
		deleted_at: new Date("2026-01-01"),
	});
	await h.seedApp({
		id: "unrelated",
		project_id: "local",
		app_name: "Unrelated",
	});
	await h.seedApp({
		id: "foreign",
		project_id: "foreign-project",
		app_name: "Private register",
	});
	mocks.govern.mockRejectedValue(
		new LookupSchemaGovernanceError(
			"referenced",
			"Apps still use this table.",
			{
				blockingAppIds: ["active", "foreign", "missing", "trashed"],
			},
		),
	);

	const result = await deleteLookupTableAction(" local ", {
		tableId: "019b0000-0000-7000-8000-000000000001",
		expectedTableRevision: "1",
	});

	expect(result).toMatchObject({
		success: false,
		code: "referenced",
		blockingApps: [
			{ appId: "trashed", appName: "Archived register", deleted: true },
			{ appId: "active", appName: "Zebra register", deleted: false },
		],
	});
});
