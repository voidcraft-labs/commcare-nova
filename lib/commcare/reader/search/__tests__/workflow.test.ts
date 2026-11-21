/**
 * Contract: a menu's three search booleans read into Nova's workflow by the rows of the workflow
 * table, and `searchWireShape` gives the stored booleans back for every row that reads; a case
 * list first whose search skips to its results, and a list first in an app with Web Apps on,
 * raise their entries. The failure it catches: Results first read as Search first; a list first
 * read from booleans Nova does not write back.
 */
import { describe, expect, it } from "vitest";
import type { SearchInputDef } from "@/lib/domain";
import { plainColumn } from "@/lib/domain/modules";
import { searchWireShape } from "../../../suite/case-search/searchWireShape";
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

async function read(change: Record<string, unknown>, cloudcare?: boolean) {
	return readLists(
		patients([plainColumn(uuid(1), "case_name", "Name")], {
			searchInputs: [field],
			search: {},
		}),
		{
			edit: (app) => {
				Object.assign(app.modules[0]?.search_config ?? {}, change);
				if (cloudcare !== undefined) app.cloudcare_enabled = cloudcare;
			},
			firstPassOnly: true,
		},
	);
}

describe("a search's workflow", () => {
	const rows: [string, Record<string, boolean>, object][] = [
		[
			"search first",
			{ auto_launch: true, default_search: false, inline_search: false },
			{},
		],
		[
			"results first",
			{ auto_launch: true, default_search: true, inline_search: false },
			{ workflow: "skipToResults" },
		],
		[
			"forms read the search",
			{ auto_launch: true, default_search: false, inline_search: true },
			{ formsReadSearch: true },
		],
		[
			"forms read the search and results first",
			{ auto_launch: true, default_search: true, inline_search: true },
			{ workflow: "skipToResults", formsReadSearch: true },
		],
		[
			"list first",
			{ auto_launch: false, default_search: false, inline_search: false },
			{ workflow: "listFirst" },
		],
	];
	for (const [name, booleans, expected] of rows)
		it(`reads ${name}, and the wire shape gives the booleans back`, async () => {
			const reading = await read(booleans, false);
			expect(codes(reading)).toEqual([]);
			// A search with a field and nothing set holds no settings object
			// (`emptySearchSettingsBesideFieldsAreAbsent`), which is search first.
			const config = (searchOf(reading) ?? {}) as Record<string, unknown>;
			expect({
				workflow: config.workflow,
				formsReadSearch: config.formsReadSearch,
			}).toEqual({
				workflow: undefined,
				formsReadSearch: undefined,
				...expected,
			});
			const shape = searchWireShape(config as never);
			expect([
				shape.autoLaunch,
				shape.defaultSearch,
				shape.inlineSearch,
			]).toEqual([
				booleans.auto_launch,
				booleans.default_search,
				booleans.inline_search,
			]);
		});

	it("raises a list first whose search skips to its results", async () => {
		const reading = await read(
			{ auto_launch: false, default_search: true, inline_search: false },
			false,
		);
		expect(codes(reading)).toContain(
			"case-search/list-first-with-a-search-that-skips-to-results",
		);
	});

	it("raises a list first in an app with Web Apps on", async () => {
		const reading = await read(
			{ auto_launch: false, default_search: false },
			true,
		);
		expect(codes(reading)).toContain(
			"case-search/workflow-legacy-classic-auto-launch-false-in-an-app-with",
		);
	});

	it("drops `inline_search` beside `auto_launch: false`", async () => {
		const reading = await read(
			{ auto_launch: false, default_search: false, inline_search: true },
			false,
		);
		expect(codes(reading)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({ workflow: "listFirst" });
	});

	it("holds a list first whose stored `inline_search` is true through the settle, and counts it", async () => {
		// The projection writes `inline_search: false` for a list first, and every reader of the
		// key in HQ's build reads it beside `auto_launch` (`util.py::module_uses_inline_search`),
		// so the settle's comparison of the whole search holds the stored `true` as the same state.
		const reading = await readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [field],
				search: { workflow: "listFirst" },
			}),
			{
				edit: (app) => {
					Object.assign(app.modules[0]?.search_config ?? {}, {
						inline_search: true,
					});
					app.cloudcare_enabled = false;
				},
			},
		);
		expect(codes(reading)).toEqual([]);
		expect(searchOf(reading)).toMatchObject({ workflow: "listFirst" });
		const counted = [...reading.ctx.close().claims.records()].filter(
			(one) =>
				one.entry === "case-search/inline-search-true-with-auto-launch-false",
		);
		expect(counted.map(({ where }) => where)).toEqual([
			"/modules/0/search_config/inline_search",
		]);
	});
});
