/**
 * Contract: a search's title reads by language (text in every language, blank in every language
 * or `{}`, blank in some raising its entry), the owner exclusion's clause leaves the list filter's
 * registered text, and the whole menu's search written back by the projection equals the stored
 * one. The failure it catches: the owner exclusion doubled in the filter; a blank title read as
 * "Search"; a setting the emitter writes back differently read as held.
 */
import { describe, expect, it } from "vitest";
import type { SearchInputDef } from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression/builders";
import { NO_SEARCH_SCREEN_TITLE, plainColumn } from "@/lib/domain/modules";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import {
	codes,
	readLists,
	searchOf,
} from "../../caseList/__tests__/listReading";

const field: SearchInputDef = {
	uuid: uuid(9),
	name: "notes",
	label: "Notes",
	kind: "simple",
	type: "text",
	property: "notes",
};

function doc(search: object = {}) {
	return patients([plainColumn(uuid(1), "case_name", "Name")], {
		searchInputs: [field],
		search,
	});
}

describe("a search's settings", () => {
	it("reads a title with text, and a subtitle", async () => {
		const reading = await readLists(
			doc({
				searchScreenTitle: "Find a patient",
				searchScreenSubtitle: "By notes",
			}),
		);
		expect(codes(reading)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({
			searchScreenTitle: "Find a patient",
			searchScreenSubtitle: "By notes",
		});
	});

	it("reads Nova's default title as no title slot", async () => {
		const reading = await readLists(doc());
		expect(codes(reading)).toEqual([]);
		expect(searchOf(reading)).not.toHaveProperty("searchScreenTitle");
	});

	it("reads a blank title as a search with no title", async () => {
		const reading = await readLists(
			doc({ searchScreenTitle: NO_SEARCH_SCREEN_TITLE }),
		);
		expect(codes(reading)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({
			searchScreenTitle: NO_SEARCH_SCREEN_TITLE,
		});
	});

	it("reads a title of `{}` as no title and records the respelling", async () => {
		const reading = await readLists(
			doc({ searchScreenTitle: NO_SEARCH_SCREEN_TITLE }),
			{
				edit: (app) => {
					const config = app.modules[0]?.search_config;
					if (config !== undefined) config.title_label = {};
				},
			},
		);
		expect(codes(reading)).toEqual([]);
		expect(
			reading.ctx.facts.sameStateRewrites.map((one) => one.register),
		).toContain("list-settings-respelled");
	});

	it("raises a title blank in some languages", async () => {
		const reading = await readLists(doc({ searchScreenTitle: "Find" }), {
			edit: (app) => {
				(app as Record<string, unknown>).langs = ["en", "fra"];
				const config = app.modules[0]?.search_config;
				if (config !== undefined) config.title_label = { en: "Find", fra: "" };
			},
			firstPassOnly: true,
		});
		expect(codes(reading)).toContain(
			"case-search/title-label-blank-in-some-languages",
		);
	});

	it("reads an owner exclusion, and the list filter's clause for it leaves the filter", async () => {
		const reading = await readLists(
			doc({ excludedOwnerIds: term(literal("abc")) }),
		);
		expect(codes(reading)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({
			excludedOwnerIds: term(literal("abc")),
		});
		const registered = reading.ctx.pending.list().map((one) => one.ref.slot);
		expect(registered).not.toContain("case_list_filter");
	});
});
