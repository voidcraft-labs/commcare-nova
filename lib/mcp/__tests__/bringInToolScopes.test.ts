/**
 * The bring-in family's scope gate, through the real SDK client and server:
 * a credential without a tool's scope gets `scope_missing` naming it, and
 * nothing behind the gate runs, so the answer says nothing of whether the
 * app, the table or the Project exists. Through the HTTP dispatch, an OAuth
 * client without it is challenged for the same scope before the tool runs.
 *
 * Every tool whose answer can carry what CommCare HQ holds needs
 * `nova.hq.import`, which no grant or key made before it holds: the fullest
 * grant there was then (every other scope) reaches none of them, the
 * write-only combination that once read a fresh review on a stale digest
 * included. Every tool that declares a scope does so through the one
 * registration helper, so its challenge and its check name the same scopes.
 *
 * The services and every read before them are replaced at the module
 * boundary only to observe that none is reached; a test that let them run
 * would prove the gate by an error they happen to throw.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { beforeEach, expect, it, vi } from "vitest";
import { dispatchMcpTools } from "@/app/api/mcp/dispatch";
import { executeWorkTool } from "@/lib/agent/authoring/session";
import { resolveAppScope } from "@/lib/db/appAccess";
import {
	getCommCareSettings,
	getHqCredentials,
	resolveHqTarget,
} from "@/lib/db/settings";
import { bringInHqChanges, reviewHqChanges } from "@/lib/deployment/hqChanges";
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
import { MCP_RESOURCE_METADATA_URL } from "@/lib/hostnames";
import { loadAppBlueprint } from "../loadApp";
import { requireProjectAccess } from "../ownership";
import { requiredToolScopes, SCOPES, TOOL_SCOPES } from "../scopes";
import { registerNovaTools } from "../server";
import { withMcpClient } from "./client";
import { resultContentText } from "./resultText";

vi.mock("@/lib/agent/authoring/session", async (original) => ({
	...(await original<typeof import("@/lib/agent/authoring/session")>()),
	executeWorkTool: vi.fn(),
}));
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
vi.mock("@/lib/deployment/hqChanges", async (original) => ({
	...(await original<typeof import("@/lib/deployment/hqChanges")>()),
	reviewHqChanges: vi.fn(),
	bringInHqChanges: vi.fn(),
}));
vi.mock("@/lib/db/settings", async (original) => ({
	...(await original<typeof import("@/lib/db/settings")>()),
	getCommCareSettings: vi.fn(),
	getHqCredentials: vi.fn(),
	resolveHqTarget: vi.fn(),
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
	executeWorkTool,
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
	resolveHqTarget,
	reviewHqChanges,
	bringInHqChanges,
] as const;

beforeEach(() => {
	for (const fn of BEHIND_THE_GATE) vi.mocked(fn).mockReset();
});

const APP = "app-somewhere";
const WORK = "0192f5a0-0000-7000-8000-000000000002";
const PROJECT = "project-somewhere";
const TABLE = "0192f5a0-0000-7000-8000-000000000001";

/** Each tool and arguments it would otherwise act on; its scopes are `TOOL_SCOPES`'. */
const TOOLS = [
	{ name: "get_preview_search_settings", args: { app_id: APP } },
	{
		name: "set_preview_search_settings",
		args: {
			work_id: WORK,
			request_id: "confirmed",
			target: { kind: "local" },
			expectedRevision: "0",
			changes: {
				timeZone: "UTC",
				maximum: 500,
				propertyMatchers: { fuzzyProperties: [], ignoredText: [] },
			},
		},
	},
	{ name: "list_hq_apps", args: { domain: "clinic" } },
	{
		name: "read_hq_app",
		args: { project_id: PROJECT, domain: "clinic", hq_app_id: "hq-app" },
	},
	{
		name: "bring_in_hq_app",
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
			owner_rule_choices: {},
		},
	},
	{
		name: "stop_publishing",
		args: {
			app_id: APP,
			server: "production",
			domain: "clinic",
			hq_app_id: "hq-app",
		},
	},
	{
		name: "inspect_lookup_source",
		args: {
			project_id: PROJECT,
			table_id: TABLE,
			operation: "worker",
			worker_username: "ana",
		},
	},
	{
		name: "refresh_managed_data",
		args: { project_id: PROJECT, table_id: TABLE },
	},
	{
		name: "refresh_managed_data",
		args: { project_id: PROJECT, app_id: APP },
	},
	{
		name: "set_lookup_table_management",
		args: {
			project_id: PROJECT,
			table_id: TABLE,
			managed_by: "nova",
			review_digest: "a".repeat(64),
		},
	},
	{
		name: "set_lookup_table_management",
		args: {
			project_id: PROJECT,
			table_id: TABLE,
			managed_by: "commcare-hq",
		},
	},
	{ name: "read_hq_changes", args: { app_id: APP, domain: "clinic" } },
	{
		name: "bring_in_hq_changes",
		args: {
			app_id: APP,
			domain: "clinic",
			reading_id: TABLE,
			review_digest: "ab".repeat(32),
			discard_nova_changes: false,
			table_choices: {},
			owner_rule_choices: {},
		},
	},
] as const;

it("requires HQ Import before a kept-settings refresh reads the app", async () => {
	const result = await callAsKey(
		"refresh_deployment",
		{ app_id: APP, server: "india", domain: "clinic", kept_values: true },
		[SCOPES.read, SCOPES.write, SCOPES.hqWrite],
	);
	expect(JSON.parse(resultContentText(result))).toMatchObject({
		error_type: "scope_missing",
		required_scope: SCOPES.hqImport,
	});
	for (const fn of BEHIND_THE_GATE) expect(fn).not.toHaveBeenCalled();
});

const EVERY_SCOPE: readonly string[] = Object.values(SCOPES);

/** One case per tool and scope it needs. */
const EACH_SCOPE = TOOLS.flatMap(({ name, args }) =>
	TOOL_SCOPES[name].map((scope) => ({ name, scope, args })),
);

async function callAsKey(
	name: string,
	args: Record<string, unknown>,
	scopes: readonly string[],
) {
	return withMcpClient(
		(server) =>
			registerNovaTools(server, {
				userId: "member",
				scopes,
				authKind: "api-key",
			}),
		(client) => client.callTool({ name, arguments: args }),
	);
}

it.each(EACH_SCOPE)(
	"answers $name without $scope with scope_missing, and reaches nothing behind the gate",
	async ({ name, scope, args }) => {
		/* Every scope but the one: no other scope stands in for it. */
		const result = await callAsKey(
			name,
			args,
			EVERY_SCOPE.filter((granted) => granted !== scope),
		);
		expect(result.isError).toBe(true);
		const message = resultContentText(result);
		expect(message).toContain("scope_missing");
		expect(JSON.parse(message)).toMatchObject({
			error_type: "scope_missing",
			required_scope: scope,
		});
		for (const fn of BEHIND_THE_GATE) expect(fn).not.toHaveBeenCalled();
	},
);

/* What a grant or key could hold before reading and bringing in from CommCare HQ had a scope of
 * its own: everything else, and the write-only combination a stale digest once answered with a
 * fresh review. */
const BEFORE_IMPORT = EVERY_SCOPE.filter((scope) => scope !== SCOPES.hqImport);
const WRITE_ONLY = [SCOPES.read, SCOPES.write, SCOPES.hqWrite];
const IMPORT_TOOLS = TOOLS.filter(({ name }) =>
	(TOOL_SCOPES[name] as readonly string[]).includes(SCOPES.hqImport),
);

it("gives every tool that can answer with CommCare HQ's content the import scope", () => {
	expect([...new Set(IMPORT_TOOLS.map(({ name }) => name))].sort()).toEqual([
		"bring_in_hq_app",
		"bring_in_hq_changes",
		"inspect_lookup_source",
		"list_hq_apps",
		"read_hq_app",
		"read_hq_changes",
		"refresh_managed_data",
		"set_lookup_table_management",
	]);
});

it.each(
	IMPORT_TOOLS.flatMap((tool) => [
		{ ...tool, grant: "the fullest grant before it", scopes: BEFORE_IMPORT },
		{ ...tool, grant: "HQ write alone", scopes: WRITE_ONLY },
	]),
)(
	"refuses $name to $grant, answering nothing of CommCare HQ",
	async ({ name, args, scopes }) => {
		const result = await callAsKey(name, args, scopes);
		expect(result.isError).toBe(true);
		const body = JSON.parse(resultContentText(result));
		expect(body).toMatchObject({ error_type: "scope_missing" });
		expect(TOOL_SCOPES[name]).toContain(body.required_scope);
		expect(Object.keys(body).sort()).not.toContain("reading");
		for (const fn of BEHIND_THE_GATE) expect(fn).not.toHaveBeenCalled();
	},
);

/* An OAuth client is challenged at HTTP before the tool runs, so it can be
 * offered the missing grant; an API key never is, which is why the tests above
 * prove only the tool's own check. This one proves each tool declares the
 * challenge for every scope it checks, and keeps the grants the client holds. */
it.each([
	...TOOLS,
	{
		name: "refresh_deployment" as const,
		args: { app_id: APP, server: "india", domain: "clinic", kept_values: true },
	},
])(
	"challenges an OAuth client holding only the floor before $name runs, naming every grant to add",
	async ({ name, args }) => {
		const scopes = [SCOPES.read, SCOPES.write, "offline_access"];
		const response = await dispatchMcpTools(
			new Request("https://mcp.commcare.app/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name, arguments: args },
				}),
			}),
			{ userId: "member", scopes, authKind: "oauth" },
			{
				token: "verified-test-token",
				clientId: "scope-test-client",
				scopes: [...scopes],
				resourceMetadataUrl: MCP_RESOURCE_METADATA_URL,
			},
		);
		await response.text();
		expect(response.status).toBe(403);
		const challenge = response.headers.get("www-authenticate");
		expect(challenge).toContain('error="insufficient_scope"');
		const grants = /scope="([^"]+)"/.exec(challenge ?? "")?.[1].split(" ");
		expect([...(grants ?? [])].sort()).toEqual(
			[...scopes, ...requiredToolScopes(name, args)].sort(),
		);
		if (name === "refresh_deployment")
			expect(grants).toContain(SCOPES.hqImport);
		for (const fn of BEHIND_THE_GATE) expect(fn).not.toHaveBeenCalled();
	},
);

it("registers a challenge for exactly the tools the scope table names", () => {
	const challenged: string[] = [];
	const registered: string[] = [];
	const server = new McpServer({ name: "scope-census", version: "0.0.0" });
	const register = server.registerTool.bind(server);
	vi.spyOn(server, "registerTool").mockImplementation(((
		name: string,
		config: { scopeChallenge?: unknown },
		callback: never,
	) => {
		registered.push(name);
		if (config.scopeChallenge !== undefined) challenged.push(name);
		return register(name, config as never, callback);
	}) as never);
	registerNovaTools(server, {
		userId: "member",
		scopes: [SCOPES.read, SCOPES.write],
		authKind: "oauth",
	});
	expect(challenged.sort()).toEqual(Object.keys(TOOL_SCOPES).sort());
	for (const name of Object.keys(TOOL_SCOPES))
		expect(registered).toContain(name);
});
