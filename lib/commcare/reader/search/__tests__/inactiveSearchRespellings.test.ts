/**
 * Contract: a search a menu does not offer is written as Nova's shell, its title and subtitle
 * blank under every app language, as HQ's Case List page saves every menu; where the stored
 * maps are spelled another way (a menu HQ's models made holds `{}`), the reading records each
 * under `list-settings-respelled` at its own key, which the first publish's register covers, and a
 * reading of Nova's own export records neither.
 *
 * The failure it catches: a first publish over an app made in CommCare HQ that rewrites a search
 * no menu offers while Nova's review lists no change there, which the proof lane's register judge
 * reports as unsaid.
 */
import { describe, expect, it } from "vitest";
import { plainColumn } from "@/lib/domain/modules";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import { codes, readLists } from "../../caseList/__tests__/listReading";

const respelled = (reading: Awaited<ReturnType<typeof readLists>>) =>
	reading.ctx.facts.sameStateRewrites
		.filter((one) => one.register === "list-settings-respelled")
		.map((one) => one.path);

describe("a search the menu does not offer", () => {
	const doc = () => patients([plainColumn(uuid(1), "case_name", "Name")]);

	it("records nothing as Nova writes it", async () => {
		const reading = await readLists(doc());
		expect(codes(reading)).toEqual([]);
		expect(respelled(reading)).toEqual([]);
	});

	it("records a title and a subtitle HQ's models stored as empty maps, each at its key", async () => {
		const reading = await readLists(doc(), {
			edit: (app) => {
				const search = app.modules[0]?.search_config;
				if (search === undefined) throw new Error("The menu holds a search.");
				search.title_label = {};
				search.description = {};
			},
		});
		expect(codes(reading)).toEqual([]);
		expect(respelled(reading)).toEqual([
			"/modules/0/search_config/title_label",
			"/modules/0/search_config/description",
		]);
	});
});
