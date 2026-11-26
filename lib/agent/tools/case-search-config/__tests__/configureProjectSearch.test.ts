import { expect, it } from "vitest";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { namedFormFixture } from "@/lib/agent/__tests__/namedFormFixture";

it("reuses a search across menus and keeps a named expression bound to its own question", async () => {
	const h = makeAuthoringHarness(
		{},
		namedFormFixture([
			{
				name: "Visits",
				caseType: "visit",
				forms: [{ name: "Visit", type: "followup" }],
			},
			{
				name: "Call backs",
				caseType: "visit",
				forms: [{ name: "Call", type: "followup" }],
			},
		]),
	);
	const prompt = await h.call("addSearchInputs", {
		moduleUuid: "Visits",
		searchInputs: [
			{
				kind: "simple",
				type: "text",
				name: "person",
				label: "Who are you looking for?",
				property: "case_name",
			},
		],
	});
	expect(prompt).not.toHaveProperty("error");
	const configure = (moduleUuid: string, change: unknown) =>
		h.call("configureProjectSearch", { moduleUuid, change });
	const search = { kind: "create", name: "Clinic directory" };
	const parameters = [{ name: "query", value: "#search/person" }];
	expect(
		await configure("Visits", {
			kind: "project",
			search,
			parameters,
			replaceFieldMatching: false,
		}),
	).toHaveProperty("error");
	const created = await configure("Visits", {
		kind: "project",
		search,
		parameters,
		replaceFieldMatching: true,
	});
	expect(created).toMatchObject({ ok: true, parameters: [{ name: "query" }] });
	const id = (created as { searchUuid: string }).searchUuid;
	expect(await h.call("getModule", { moduleUuid: "Visits" })).toMatchObject({
		available_project_searches: [{ uuid: id, name: "Clinic directory" }],
		case_search_config: {
			projectSearch: { defaults: [{ name: "query", value: "#search/person" }] },
		},
	});
	const shared = await configure("Call backs", {
		kind: "project",
		search: { kind: "named", name: "Clinic directory" },
		parameters: [{ name: "status", value: "'open'" }],
		replaceFieldMatching: false,
	});
	expect(shared).toMatchObject({ searchUuid: id, ok: true });
	expect(
		await configure("Call backs", {
			kind: "rename",
			uuid: id,
			name: "Directory",
		}),
	).toMatchObject({ ok: true });
	expect(
		await configure("Visits", { kind: "remove", uuid: id }),
	).toHaveProperty("error");
});
