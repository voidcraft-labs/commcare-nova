/**
 * The bring-in family's scope gate, through the real SDK client and server:
 * a credential without a tool's scope gets `scope_missing` naming it, and
 * nothing behind the gate runs, so the answer says nothing of whether the
 * app, the table or the Project exists.
 *
 * The services and every read before them are replaced at the module
 * boundary only to observe that none is reached; a test that let them run
 * would prove the gate by an error they happen to throw.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { resolveAppScope } from "@/lib/db/appAccess";
import { getCommCareSettings, getHqCredentials } from "@/lib/db/settings";
import {
	letHqManageLookupTable,
	manageLookupTableInNova,
	readManagedLookupTableView,
	refreshManagedLookupTable,
	refreshManagedPlaces,
} from "@/lib/deployment/managedData";
import {
	authorizeBringIn,
	createFromReview,
	listHqAppsForPicker,
	readHqAppForReview,
} from "@/lib/deployment/reading";
import { stopPublishing } from "@/lib/deployment/service";
import { loadAppBlueprint } from "../loadApp";
import { requireProjectAccess } from "../ownership";
import { registerNovaTools } from "../server";
import { withMcpClient } from "./client";
import { resultContentText } from "./resultText";

vi.mock("@/lib/deployment/service", async (original) => ({
	...(await original<typeof import("@/lib/deployment/service")>()),
	stopPublishing: vi.fn(),
}));
vi.mock("@/lib/deployment/managedData", async (original) => ({
	...(await original<typeof import("@/lib/deployment/managedData")>()),
	refreshManagedLookupTable: vi.fn(),
	refreshManagedPlaces: vi.fn(),
	manageLookupTableInNova: vi.fn(),
	letHqManageLookupTable: vi.fn(),
	readManagedLookupTableView: vi.fn(),
}));
vi.mock("@/lib/deployment/reading", async (original) => ({
	...(await original<typeof import("@/lib/deployment/reading")>()),
	listHqAppsForPicker: vi.fn(),
	authorizeBringIn: vi.fn(),
	readHqAppForReview: vi.fn(),
	createFromReview: vi.fn(),
}));
vi.mock("@/lib/db/settings", async (original) => ({
	...(await original<typeof import("@/lib/db/settings")>()),
	getCommCareSettings: vi.fn(),
	getHqCredentials: vi.fn(),
}));
vi.mock("@/lib/db/appAccess", async (original) => ({
	...(await original<typeof import("@/lib/db/appAccess")>()),
	resolveAppScope: vi.fn(),
}));
vi.mock("../loadApp", async (original) => ({
	...(await original<typeof import("../loadApp")>()),
	loadAppBlueprint: vi.fn(),
}));
vi.mock("../ownership", async (original) => ({
	...(await original<typeof import("../ownership")>()),
	requireProjectAccess: vi.fn(),
}));

const BEHIND_THE_GATE = [
	stopPublishing,
	refreshManagedLookupTable,
	refreshManagedPlaces,
	manageLookupTableInNova,
	letHqManageLookupTable,
	readManagedLookupTableView,
	resolveAppScope,
	loadAppBlueprint,
	requireProjectAccess,
	listHqAppsForPicker,
	authorizeBringIn,
	readHqAppForReview,
	createFromReview,
	getCommCareSettings,
	getHqCredentials,
] as const;

beforeEach(() => {
	for (const fn of BEHIND_THE_GATE) vi.mocked(fn).mockReset();
});

const APP = "app-somewhere";
const PROJECT = "project-somewhere";
const TABLE = "0192f5a0-0000-7000-8000-000000000001";

/** Each tool, the scope it needs, and arguments it would otherwise act on. */
const TOOLS = [
	{
		name: "list_hq_apps",
		scope: "nova.hq.read",
		args: { domain: "clinic" },
	},
	{
		name: "read_hq_app",
		scope: "nova.hq.read",
		args: { project_id: PROJECT, domain: "clinic", hq_app_id: "hq-app" },
	},
	{
		name: "bring_in_hq_app",
		scope: "nova.hq.write",
		args: {
			project_id: PROJECT,
			domain: "clinic",
			hq_app_id: "hq-app",
			reading_id: TABLE,
			review_digest: "ab".repeat(32),
			app_name: "Clinic visits",
			runs_only_on: null,
			split_datetime: false,
			table_choices: {},
		},
	},
	{
		name: "stop_publishing",
		scope: "nova.hq.write",
		args: { app_id: APP, server: "production", domain: "clinic" },
	},
	{
		name: "refresh_managed_data",
		scope: "nova.hq.write",
		args: { project_id: PROJECT, table_id: TABLE },
	},
	{
		name: "refresh_managed_data",
		scope: "nova.hq.write",
		args: { project_id: PROJECT, app_id: APP },
	},
	{
		name: "set_lookup_table_management",
		scope: "nova.hq.write",
		args: {
			project_id: PROJECT,
			table_id: TABLE,
			managed_by: "nova",
			confirmed: true,
		},
	},
	{
		name: "set_lookup_table_management",
		scope: "nova.hq.write",
		args: {
			project_id: PROJECT,
			table_id: TABLE,
			managed_by: "commcare-hq",
			confirmed: false,
		},
	},
] as const;

it.each(TOOLS)(
	"answers $name without $scope with scope_missing, and reaches nothing behind the gate",
	async ({ name, scope, args }) => {
		/* Every scope but the one the tool needs: HQ read does not stand in for
		 * HQ write. */
		const scopes = [
			"nova.read",
			"nova.write",
			"nova.hq.read",
			"nova.hq.write",
			"nova.projects.read",
			"nova.projects.write",
		].filter((granted) => granted !== scope);
		const result = await withMcpClient(
			(server) =>
				registerNovaTools(server, {
					userId: "member",
					scopes,
					authKind: "api-key",
				}),
			(client) => client.callTool({ name, arguments: args }),
		);
		expect(result.isError).toBe(true);
		expect(JSON.parse(resultContentText(result))).toMatchObject({
			error_type: "scope_missing",
			required_scope: scope,
		});
		for (const fn of BEHIND_THE_GATE) expect(fn).not.toHaveBeenCalled();
	},
);
