/** Actual membership joins, SQL pagination, search ranking and MCP inputs. */
import { sql } from "kysely";
import { expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { registerListApps } from "../tools/listApps";
import { registerSearchApps } from "../tools/searchApps";
import { withMcpClient } from "./client";
import { resultText } from "./promptClient";

const h = setupAppStateTestDb("mcp_listing_", { authSchema: "migrated" });
const ACTOR = "member";
function register(userId = ACTOR): Parameters<typeof withMcpClient>[0] {
	return (server) => {
		const ctx = {
			userId,
			scopes: ["nova.read", "nova.write"],
			authKind: "oauth" as const,
		};
		registerListApps(server, ctx);
		registerSearchApps(server, ctx);
	};
}
interface Entry {
	app_id: string;
	name: string;
	status: string;
	updated_at: string;
	project_id: string;
	project_name: string;
}
interface Page {
	apps: Entry[];
	next_cursor?: string;
}
async function fixture() {
	const rows = [
		{
			id: "a",
			name: "Alpha",
			rank: 5,
			project: "one",
			status: "complete" as const,
		},
		{
			id: "b",
			name: "alpha",
			rank: 5,
			project: "two",
			status: "complete" as const,
		},
		{
			id: "c",
			name: "Zeta",
			rank: 4,
			project: "one",
			status: "error" as const,
		},
		{
			id: "d",
			name: "Beta",
			rank: 3,
			project: "two",
			status: "complete" as const,
		},
		{
			id: "e",
			name: "Aardvark",
			rank: 1,
			project: "one",
			status: "complete" as const,
		},
	];
	const entries: Record<string, Entry> = {};
	for (const row of rows) {
		const updated_at = `2026-04-0${row.rank}T00:00:00.000Z`;
		await h.seedApp({
			id: row.id,
			app_name: row.name,
			owner: "author",
			project_id: row.project,
			status: row.status,
			updated_at: new Date(updated_at),
		});
		entries[row.id] = {
			app_id: row.id,
			name: row.name,
			status: row.status,
			updated_at,
			project_id: row.project,
			project_name: row.project === "one" ? "Team one" : "Team two",
		};
	}
	await h.seedApp({
		id: "deleted",
		app_name: "Alpha",
		owner: "author",
		project_id: "one",
		deleted_at: new Date(),
		recoverable_until: new Date(Date.now() + 60_000),
	});
	// Creation provenance must not restore membership in a Project the actor left.
	await h.seedApp({
		id: "foreign",
		app_name: "Alpha",
		owner: ACTOR,
		project_id: "foreign",
	});
	await sql`DELETE FROM auth_member WHERE "userId" = ${ACTOR}`.execute(h.db());
	await h.seedProjectMember(ACTOR, "one", "viewer");
	await h.seedProjectMember(ACTOR, "two", "editor");
	await sql`UPDATE auth_organization SET name = 'Team one' WHERE id = 'one'`.execute(
		h.db(),
	);
	await sql`UPDATE auth_organization SET name = 'Team two' WHERE id = 'two'`.execute(
		h.db(),
	);
	return entries;
}
it("enumerates exact entries across current Projects and respects all four sorts across tied page boundaries", async () => {
	const entries = await fixture();
	await withMcpClient(register(), async (client) => {
		expect(
			JSON.parse(
				resultText(await client.callTool({ name: "list_apps", arguments: {} })),
			),
		).toEqual({
			apps: [entries.a, entries.b, entries.c, entries.d, entries.e],
		});
		for (const [sort, ids] of [
			["updated_desc", ["a", "b", "c", "d", "e"]],
			["updated_asc", ["e", "d", "c", "a", "b"]],
			["name_asc", ["e", "a", "b", "d", "c"]],
			["name_desc", ["c", "d", "a", "b", "e"]],
		] as const) {
			const all: Entry[] = [];
			const cursors = new Set<string>();
			let cursor: string | undefined;
			do {
				const page = JSON.parse(
					resultText(
						await client.callTool({
							name: "list_apps",
							arguments: { limit: 2, sort, ...(cursor ? { cursor } : {}) },
						}),
					),
				) as Page;
				expect(Object.keys(page).sort()).toEqual(
					page.next_cursor ? ["apps", "next_cursor"] : ["apps"],
				);
				expect(page.apps.length).toBeLessThanOrEqual(2);
				all.push(...page.apps);
				cursor = page.next_cursor;
				if (cursor) {
					expect(cursors.has(cursor)).toBe(false);
					cursors.add(cursor);
					expect(cursors.size).toBeLessThanOrEqual(3);
				}
			} while (cursor);
			expect(all).toEqual(ids.map((id) => entries[id]));
		}
		expect(
			JSON.parse(
				resultText(
					await client.callTool({
						name: "list_apps",
						arguments: { status: "error" },
					}),
				),
			),
		).toEqual({ apps: [entries.c] });
		await sql`DELETE FROM auth_member WHERE "userId" = ${ACTOR} AND "organizationId" = 'two'`.execute(
			h.db(),
		);
		expect(
			JSON.parse(
				resultText(await client.callTool({ name: "list_apps", arguments: {} })),
			),
		).toEqual({ apps: [entries.a, entries.c, entries.e] });
	});
	await withMcpClient(register("no-memberships"), async (client) => {
		for (const [name, args] of [
			["list_apps", {}],
			["search_apps", { query: "Alpha" }],
		] as const) {
			expect(
				JSON.parse(
					resultText(await client.callTool({ name, arguments: args })),
				),
			).toEqual({ apps: [] });
		}
	});
});
it("searches case-insensitively with typos across memberships, ranks matches and applies status and result limits", async () => {
	await fixture();
	for (const [id, name, project, status] of [
		["vaccine", "Vaccine Tracker", "one", "complete"],
		["survey", "COVID Vaccine Survey", "two", "error"],
		["excluded", "Vaccine", "foreign", "complete"],
	] as const)
		await h.seedApp({
			id,
			app_name: name,
			owner: "author",
			project_id: project,
			status,
		});
	await withMcpClient(register(), async (client) => {
		const search = async (args: Record<string, unknown>) =>
			JSON.parse(
				resultText(
					await client.callTool({ name: "search_apps", arguments: args }),
				),
			) as Page;
		const result = await search({ query: "VACINE" });
		expect(result.apps.map((app) => app.app_id)).toEqual(["vaccine", "survey"]);
		expect(
			result.apps.map((app) => [app.project_id, app.project_name]),
		).toEqual([
			["one", "Team one"],
			["two", "Team two"],
		]);
		expect(result.next_cursor).toBeUndefined();
		expect(
			(await search({ query: "vaccine", limit: 1 })).apps.map(
				(app) => app.app_id,
			),
		).toEqual(["vaccine"]);
		expect(
			(await search({ query: "vaccine", status: "error" })).apps.map(
				(app) => app.app_id,
			),
		).toEqual(["survey"]);
		expect(await search({ query: "zzzzzzzzzz" })).toEqual({ apps: [] });
	});
});
it("carries the scan cursor through an empty search page to an older matching app", async () => {
	await h.seedProjectMember(ACTOR, "one", "viewer");
	for (let i = 0; i < 120; i++)
		await h.seedApp({
			id: `recent-${i}`,
			owner: "author",
			project_id: "one",
			app_name: `Orchard ${i}`,
			updated_at: new Date("2026-06-01T00:00:00Z"),
		});
	await h.seedApp({
		id: "older-match",
		owner: "author",
		project_id: "one",
		app_name: "Vaccine Tracker",
		updated_at: new Date("2026-05-01T00:00:00Z"),
	});
	await withMcpClient(register(), async (client) => {
		const first = JSON.parse(
			resultText(
				await client.callTool({
					name: "search_apps",
					arguments: { query: "vaccine", limit: 1 },
				}),
			),
		) as Page;
		expect(first.apps).toEqual([]);
		expect(first.next_cursor).toEqual(expect.any(String));
		const second = JSON.parse(
			resultText(
				await client.callTool({
					name: "search_apps",
					arguments: { query: "vaccine", limit: 1, cursor: first.next_cursor },
				}),
			),
		) as Page;
		expect(second.apps.map((app) => app.app_id)).toEqual(["older-match"]);
		expect(second.next_cursor).toBeUndefined();
	});
});
it("rejects schema-invalid list/search inputs through SDK dispatch", async () => {
	await withMcpClient(register(), async (client) => {
		for (const args of [
			{ limit: 0 },
			{ limit: 101 },
			{ limit: 1.5 },
			{ limit: "10" },
			{ status: "deleted" },
			{ sort: "random" },
		]) {
			const result = await client.callTool({
				name: "list_apps",
				arguments: args,
			});
			expect(result.isError).toBe(true);
			expect(result.content).toEqual([
				{
					type: "text",
					text: expect.stringContaining("Input validation error"),
				},
			]);
		}
		for (const args of [
			{},
			{ query: "" },
			{ query: "x".repeat(101) },
			{ query: "x", limit: 0 },
		]) {
			const result = await client.callTool({
				name: "search_apps",
				arguments: args,
			});
			expect(result.isError).toBe(true);
			expect(result.content).toEqual([
				{
					type: "text",
					text: expect.stringContaining("Input validation error"),
				},
			]);
		}
	});
});
it("classifies malformed and mismatched list/search cursors as fixable input", async () => {
	await fixture();
	await withMcpClient(register(), async (client) => {
		const first = JSON.parse(
			resultText(
				await client.callTool({
					name: "list_apps",
					arguments: { limit: 1, sort: "name_asc" },
				}),
			),
		) as Page;
		expect(first.next_cursor).toEqual(expect.any(String));
		const invalidDate = Buffer.from(
			JSON.stringify({
				kind: "updated_desc",
				updated_at: "not-a-date",
				id: "a",
			}),
		).toString("base64url");
		for (const [name, args] of [
			["list_apps", { cursor: "invalid" }],
			["list_apps", { cursor: first.next_cursor }],
			["list_apps", { cursor: invalidDate }],
			["search_apps", { query: "Alpha", cursor: first.next_cursor }],
		] as const) {
			const result = await client.callTool({ name, arguments: args });
			expect(result.isError).toBe(true);
			const content = result.content as [{ type: "text"; text: string }];
			expect(JSON.parse(content[0].text)).toEqual({
				error_type: "invalid_input",
				message: expect.any(String),
			});
		}
	});
});
