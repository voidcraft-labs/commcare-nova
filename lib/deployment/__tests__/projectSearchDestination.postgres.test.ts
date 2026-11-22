import { expect, it } from "vitest";
import {
	patients,
	uuid,
} from "@/lib/commcare/reader/caseList/__tests__/fixtures";
import {
	closedCodes,
	readLists,
} from "@/lib/commcare/reader/caseList/__tests__/listReading";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { plainColumn, projectSearchOf } from "@/lib/domain/modules";
import { withMcpClient } from "@/lib/mcp/__tests__/client";
import { resultText } from "@/lib/mcp/__tests__/resultText";
import { registerProjectSearchDestinations } from "@/lib/mcp/tools/projectSearchDestinations";
import {
	inspectProjectSearchDestination,
	saveProjectSearchDestination,
} from "../store";

const h = setupAppStateTestDb();
const scope = {
	actorUserId: "author",
	role: "owner",
	appId: "project-search-test",
	projectId: "search-project",
};
const target = { server: "production" as const, domain: "first-space" };

async function readDirectory() {
	const source = patients([plainColumn(uuid(1), "case_name", "Name")], {
		search: {},
	});
	const read = await readLists(source, {
		edit(app) {
			const config = app.modules[0]?.search_config;
			if (!config) throw new Error("Source search missing.");
			config.case_search_endpoint_id = 17;
			config.default_properties = [
				{ property: "district", defaultValue: "'north'" },
			];
		},
	});
	expect(closedCodes(read)).toEqual([]);
	const doc = read.ctx.doc;
	const menu = read.ctx.draft.modules[0];
	if (!doc || !menu) throw new Error("Reading did not return its document.");
	const search = projectSearchOf(doc.modules[menu.uuid]);
	if (!search) throw new Error("The search was lost.");
	return { doc, menu, search };
}

it("requires the current actor, app, target and connection review before replacing an external service ID", async () => {
	const { doc, search } = await readDirectory();
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	await h.seedProjectMember("coauthor", scope.projectId, "editor");
	await h.seedProjectMember("reader", scope.projectId, "viewer");
	const initial = (await inspectProjectSearchDestination(scope, target)).review;
	expect(initial.searches).toMatchObject([
		{
			searchUuid: search.searchUuid,
			endpointId: null,
			menus: [
				{
					parameters: ["district"],
					results: [
						{ name: "case_id", type: "text" },
						{ name: "case_name", type: "text" },
					],
				},
			],
		},
	]);
	const bind = (version: string, endpointId: number | null) => ({
		version,
		bindings: [{ searchUuid: search.searchUuid, endpointId }],
	});
	const coauthor = { ...scope, actorUserId: "coauthor", role: "editor" };
	await expect(
		saveProjectSearchDestination(coauthor, target, bind(initial.version, 41)),
	).rejects.toThrow(/changed/);
	const other = { ...target, domain: "second-space" };
	await expect(
		saveProjectSearchDestination(scope, other, bind(initial.version, 41)),
	).rejects.toThrow(/changed/);
	const viewer = { ...scope, actorUserId: "reader", role: "viewer" };
	const viewed = (await inspectProjectSearchDestination(viewer, target)).review;
	await expect(
		saveProjectSearchDestination(viewer, target, bind(viewed.version, 41)),
	).rejects.toThrow();
	const updated = await saveProjectSearchDestination(
		scope,
		target,
		bind(initial.version, 17),
	);
	expect(updated.searches[0]?.endpointId).toBe(17);
	await expect(
		saveProjectSearchDestination(scope, target, bind(initial.version, 71)),
	).rejects.toThrow(/changed/);
	const elsewhere = (await inspectProjectSearchDestination(scope, other))
		.review;
	expect(elsewhere.searches[0]?.endpointId).toBeNull();
	await saveProjectSearchDestination(scope, other, bind(elsewhere.version, 91));
	await saveProjectSearchDestination(
		scope,
		target,
		bind(updated.version, null),
	);
	expect(
		(await inspectProjectSearchDestination(scope, other)).review.searches[0]
			?.endpointId,
	).toBe(91);
	expect(
		(await inspectProjectSearchDestination(viewer, target)).review.searches[0]
			?.endpointId,
	).toBeNull();
});

it("keeps the complete destination review inside the MCP limit before returning the write version", async () => {
	const reading = await readDirectory();
	const { menu, search } = reading;
	const doc = structuredClone(reading.doc);
	if (!doc.appSettings.projectSearches)
		throw new Error("The app has no directory.");
	const label = '"🚲'.repeat(38_000);
	doc.appSettings.projectSearches[search.searchUuid] = { name: label };
	doc.modules[menu.uuid].name = "Clinic " + label;
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	await withMcpClient(
		(server) =>
			registerProjectSearchDestinations(server, {
				userId: scope.actorUserId,
				authKind: "oauth",
				scopes: ["nova.read", "nova.hq.read"],
			}),
		async (client) => {
			type Page = { from: number; token: string };
			const read = async (domain: string, page?: Page) => {
				const result = await client.callTool({
					name: "get_project_search_destination",
					arguments: {
						app_id: scope.appId,
						server: target.server,
						domain,
						page,
					},
				});
				expect(JSON.stringify(result).length).toBeLessThanOrEqual(100_000);
				const text = resultText(result);
				expect(text.length).toBeLessThanOrEqual(80_000);
				return JSON.parse(text) as {
					restarted: boolean;
					version: string | null;
					next_page: Page | null;
					details: {
						kind: string;
						text: string;
						searchUuid: string;
						menuUuid?: string;
					}[];
				};
			};
			let current = await read(target.domain);
			expect(current.version).toBeNull();
			const first = current.next_page;
			if (!first) throw new Error("Expected another review page.");
			const elsewhere = await read("different-space", first);
			expect(elsewhere.restarted).toBe(true);
			expect(elsewhere.version).toBeNull();
			expect(elsewhere.details).toEqual(current.details);
			const all = [...current.details];
			while (current.next_page !== null) {
				expect(current.version).toBeNull();
				current = await read(target.domain, current.next_page);
				expect(current.restarted).toBe(false);
				all.push(...current.details);
			}
			expect(current.version).toBe(
				(await inspectProjectSearchDestination(scope, target)).review.version,
			);
			expect(all.every((row) => row.searchUuid === search.searchUuid)).toBe(
				true,
			);
			expect(
				all
					.filter((row) => row.kind === "search")
					.map((row) => row.text)
					.join(""),
			).toBe(label);
			expect(
				all
					.filter((row) => row.kind === "menu" && row.menuUuid === menu.uuid)
					.map((row) => row.text)
					.join(""),
			).toBe("Clinic " + label);
			expect(
				all.filter((row) => row.kind === "parameter").map((row) => row.text),
			).toEqual(["district"]);
			expect(
				all.filter((row) => row.kind === "result").map((row) => row.text),
			).toEqual(["case_id", "case_name"]);
		},
	);
}, 30_000);
