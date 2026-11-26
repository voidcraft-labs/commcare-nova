/**
 * Contract: a refused column, a refused custom tile cell and a callout are each refused whole,
 * so one cause is one finding: every key of the refused thing the reading leaves is claimed under
 * that refusal, and the close names nothing of it. The failure it catches: a refusal that claims
 * the key it judged and leaves the rest of the column (its mapping, its entry point, its field,
 * its tile cell) for the close, which then reports each as `unrecognized`, several findings for
 * one cause. Each case stores the keys CommCare HQ's Case List page writes on a column
 * (`details/bootstrap5/column.js::serialize`) beside the one change that makes the class.
 */
import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { plainColumn } from "@/lib/domain/modules";
import { namingFromHqPages } from "../../__tests__/hqPageNames";
import { patients, uuid } from "./fixtures";
import {
	type AppJson,
	closedCodes,
	type Detail,
	listOf,
	readLists as readListsOf,
} from "./listReading";

const M = "menus-and-case-lists/";

const readLists = namingFromHqPages(readListsOf);

/** The cell keys HQ's page writes on every column of a custom tile. */
const CELL = {
	grid_x: 0,
	grid_y: 0,
	width: 6,
	height: 1,
	horizontal_align: "left",
	vertical_align: "start",
	font_size: "medium",
	show_border: true,
	show_shading: true,
};

/** A mapping HQ's page saves on every column, which only a mapping format reads. */
const MAPPING = [{ key: "a", value: { en: "A" }, alt_text: { en: "" } }];

/** Reads two columns after `edit` changed their stored details. */
async function readDetails(
	edit: (short: Detail, long: Detail, app: AppJson) => void,
) {
	return readLists(
		patients([
			plainColumn(uuid(1), "case_name", "Name"),
			plainColumn(uuid(2), "notes", "Notes"),
		]),
		{
			edit: (app) => {
				const pair = app.modules[0]?.case_details;
				if (pair !== undefined) edit(pair.short, pair.long, app);
			},
			firstPassOnly: false,
		},
	);
}

/** Reads the list after the second column of `screen` took `change`, on a custom tile where
 *  `tile` holds. */
async function readColumn(
	change: Record<string, unknown>,
	screen: "short" | "long" = "short",
	tile = false,
) {
	return readDetails((short, long) => {
		if (tile) {
			short.case_tile_template = "custom";
			short.columns.forEach((column, index) => {
				Object.assign(column, CELL, { grid_y: index });
			});
		}
		const column = (screen === "short" ? short : long).columns[1];
		if (column !== undefined) Object.assign(column, change);
	});
}

describe("a refused column", () => {
	const cases: [string, Record<string, unknown>, "short" | "long", string][] = [
		[
			"a clickable icon on the list naming an entry point, with its mapping",
			{
				format: "clickable-icon",
				enum: MAPPING,
				endpoint_action_id: "open_visit",
			},
			"short",
			`${M}clickable-icon-with-an-unusable-form-endpoint`,
		],
		[
			"a clickable icon on the list with no entry point, with its mapping",
			{ format: "clickable-icon", enum: MAPPING },
			"short",
			`${M}16p-clickable-icon-with-an-empty-endpoint-action-id-on-the-case`,
		],
		[
			"a clickable icon on the detail, with its mapping and entry point",
			{
				format: "clickable-icon",
				enum: MAPPING,
				endpoint_action_id: "open_visit",
			},
			"long",
			`${M}16pp-clickable-icon-on-the-case-detail-whatever-its-endpoint`,
		],

		[
			"a date pattern Core does not format",
			{ format: "date", date_format: "%Q" },
			"short",
			`${M}2p-date-any-other-date-format`,
		],
		[
			"an ID mapping with a key holding &",
			{ format: "enum", enum: [{ key: "a&b", value: { en: "A" } }] },
			"short",
			`${M}5p-enum-key-containing`,
		],
		[
			"a product column",
			{ model: "product", format: "date", date_format: "%d/%m/%y" },
			"short",
			`${M}model-product`,
		],
		[
			"a calculated translatable text with a key outside the editor's grammar",
			{
				format: "translatable-enum",
				useXpathExpression: true,
				field: "notes",
				enum: [{ key: "a b", value: { en: "A" } }],
			},
			"short",
			`${M}21p-translatable-enum-key-outside-a-za-z0-9`,
		],
	];
	for (const [name, change, screen, entry] of cases)
		it(`raises ${name} as one finding`, async () => {
			expect(closedCodes(await readColumn(change, screen))).toEqual([entry]);
		});

	it("records the entire icon action when its deep link opens a registration form", async () => {
		const entry = `${M}clickable-icon-with-an-unusable-form-endpoint`;
		const image = "jr://file/commcare/image/register_household.png";
		const reading = await readLists(
			patients([
				plainColumn(uuid(1), "case_name", "Name"),
				plainColumn(uuid(2), "notes", "Notes"),
			]),
			{
				edit(app) {
					app.cloudcare_enabled = true;
					const module = app.modules[0];
					const [registration] = module.forms as Array<Record<string, unknown>>;
					registration.session_endpoint_id = "register_household";
					Object.assign(module.case_details.short.columns[1], {
						format: "clickable-icon",
						endpoint_action_id: "register_household",
						enum: [
							{ doc_type: "MappingItem", key: "true()", value: { en: image } },
						],
					});
				},
				input: (input) => ({
					...input,
					media: {
						...input.media,
						resolve: (path) =>
							path === image
								? {
										kind: "asset",
										assetId: testMediaAssetId("registration icon"),
										mediaKind: "image",
									}
								: input.media.resolve(path),
					},
				}),
			},
		);
		expect(closedCodes(reading)).toEqual([entry]);
		const records = [...reading.ctx.close().claims.records()].filter(
			(record) => record.entry === entry && record.standing === "fix-in-hq",
		);
		const column = "/modules/0/case_details/short/columns/1";
		expect(new Set(records.map(({ where, key }) => `${where} ${key}`))).toEqual(
			new Set([
				`${column}/format schema:DetailColumn.format`,
				`${column}/endpoint_action_id schema:DetailColumn.endpoint_action_id`,
				`${column}/enum schema:DetailColumn.enum`,
				`${column}/enum/0/key schema:MappingItem.key`,
				`${column}/enum/0/value schema:MappingItem.value`,
			]),
		);
	});

	it("keeps an explicit blank image rule and its place among the matches", async () => {
		const reading = await readColumn({
			format: "enum-image",
			enum: [{ key: "a", value: { en: "" } }],
		});
		expect(closedCodes(reading)).toEqual([]);
		const columns = listOf(reading).columns;
		expect(columns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "image-map",
					mapping: [expect.objectContaining({ value: "a", match: "exact" })],
				}),
			]),
		);
	});

	it("retains a Search Only field at its placed Android tile cell", async () => {
		const reading = await readColumn({ format: "invisible" }, "short", true);
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).columns[1]?.tile).toMatchObject({
			x: 0,
			y: 1,
			width: 6,
			height: 1,
			androidOnly: true,
		});
	});

	it("leaves an address column’s unused tile keys to their own row", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short.columns[1] ?? {}, CELL, { format: "address" });
		});
		expect(closedCodes(reading)).toEqual([]);
		const records = [...reading.ctx.close().claims.records()].filter((one) =>
			one.where.endsWith("/short/columns/1/width"),
		);
		expect(records.map((one) => one.entry)).toEqual([
			`${M}tile-cell-keys-on-a-list-that-is-not-a-tile`,
		]);
	});

	it("accounts for an admitted conditional label table under its own inventory entry", async () => {
		const reading = await readColumn({
			format: "conditional-enum",
			enum: MAPPING,
		});
		const records = [...reading.ctx.close().claims.records()].filter((one) =>
			one.where.endsWith("/short/columns/1/enum"),
		);
		expect(records.map((one) => [one.key, one.entry])).toEqual([
			["schema:DetailColumn.enum", `${M}20-conditional-enum`],
		]);
	});

	// HQ's build reads a clickable icon's mapping as an image map's (`detail_screen.py::ClickableIcon`
	// is an `EnumImage`), so a refused icon's mapping is claimed at its key under the icon's entry.
	const icons: [string, Record<string, unknown>, "short" | "long", string][] = [
		[
			"on the list with no entry point",
			{ format: "clickable-icon", enum: MAPPING },
			"short",
			`${M}16p-clickable-icon-with-an-empty-endpoint-action-id-on-the-case`,
		],
		[
			"on the detail",
			{
				format: "clickable-icon",
				enum: MAPPING,
				endpoint_action_id: "open_visit",
			},
			"long",
			`${M}16pp-clickable-icon-on-the-case-detail-whatever-its-endpoint`,
		],
	];
	for (const [name, change, screen, entry] of icons)
		it(`claims the mapping of a refused clickable icon ${name} at its key`, async () => {
			const reading = await readColumn(change, screen);
			const records = [...reading.ctx.close().claims.records()].filter((one) =>
				one.where.endsWith(`/${screen}/columns/1/enum`),
			);
			expect(records.map((one) => [one.key, one.entry])).toEqual([
				["schema:DetailColumn.enum", entry],
			]);
		});
});

describe("a refused custom tile cell", () => {
	const cases: [string, readonly string[], string][] = [
		[
			"with no place",
			["grid_x", "grid_y"],
			`${M}custom-tile-column-with-grid-null-unplaced`,
		],
		[
			"with no alignment",
			["horizontal_align"],
			`${M}horizontal-align-null-on-a-placed-custom-tile-column`,
		],
		["with no size", ["font_size"], `${M}custom-tile-font-size-null`],
	];
	for (const [name, absent, entry] of cases)
		it(`raises a cell ${name} as one finding`, async () => {
			const reading = await readDetails((short) => {
				short.case_tile_template = "custom";
				short.columns.forEach((column, index) => {
					Object.assign(column, CELL, { grid_y: index });
				});
				const column = short.columns[1] ?? {};
				for (const key of absent) delete column[key];
			});
			expect(closedCodes(reading)).toEqual([entry]);
		});

	it("reads a cell beside it in full", async () => {
		const reading = await readDetails((short) => {
			short.case_tile_template = "custom";
			short.columns.forEach((column, index) => {
				Object.assign(column, CELL, { grid_y: index });
			});
		});
		expect(closedCodes(reading)).toEqual([]);
	});
});

describe("a callout on the case list", () => {
	const callout = {
		lookup_enabled: true,
		lookup_action: "org.example.SCAN",
		lookup_name: "Scan",
		lookup_image: "jr://file/commcare/image/scan.png",
		lookup_autolaunch: true,
		lookup_display_results: true,
		lookup_field_header: { en: "Scanned" },
		lookup_field_template: "@case_id",
	};

	it("refuses a relative lookup extra before the case list opens", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short, callout, {
				lookup_extras: [{ key: "mode", value: "scan" }],
				lookup_responses: [{ key: "result" }],
			});
		});
		expect(closedCodes(reading)).toEqual([
			`${M}lookup-extra-relative-without-case-context`,
		]);
	});

	it.each([
		[
			"empty heading map",
			{},
			"@case_id",
			"lookup-case-id-result-without-a-header-map",
		],
		[
			"stored blank heading",
			{ en: "" },
			"@case_id",
			"lookup-enabled-lookup-action",
		],
		[
			"result formula",
			{ en: "Scanned" },
			"concat(scan_id, 'x')",
			"lookup-enabled-lookup-action",
		],
	])(
		"keeps a distinct finding for %s",
		async (_label, header, template, entry) => {
			const reading = await readDetails((short) => {
				Object.assign(short, callout, {
					lookup_extras: [{ key: "mode", value: "'scan'" }],
					lookup_responses: [{ key: "result" }],
					lookup_field_header: header,
					lookup_field_template: template,
				});
			});
			expect(closedCodes(reading)).toEqual([`${M}${entry}`]);
		},
	);

	it("with no extras is one finding, HQ's own refusal", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short, callout, {
				lookup_extras: [],
				lookup_responses: [{ key: "result" }],
			});
		});
		expect(closedCodes(reading)).toEqual([
			`${M}callout-with-no-extras-or-no-responses`,
		]);
	});

	it("on the case detail is one finding", async () => {
		const reading = await readDetails((_short, long) => {
			Object.assign(long, callout, {
				lookup_extras: [{ key: "mode", value: "scan" }],
				lookup_responses: [{ key: "result" }],
			});
		});
		expect(closedCodes(reading)).toEqual([
			`${M}lookup-on-the-long-detail-tabbed-or-not`,
		]);
	});
});

describe("a calculated column", () => {
	// HQ's build reads the menu's `auto_launch` whether or not the menu offers search, and Nova's
	// shell writes it on for an app that runs in Web Apps, so each case states it.
	const readCalculated = (field: string, autoLaunch: boolean) =>
		readDetails((short, _long, app) => {
			Object.assign(short.columns[1] ?? {}, {
				useXpathExpression: true,
				field,
			});
			const search = app.modules[0]?.search_config;
			if (search !== undefined) search.auto_launch = autoLaunch;
		});

	it("reading the search's results in a menu whose search does not launch by itself is HQ's refusal alone", async () => {
		for (const field of [
			"count(instance('results')/results/case)",
			"count(instance('search-input:results')/input/field)",
		]) {
			const reading = await readCalculated(field, false);
			expect(closedCodes(reading), field).toEqual([
				`${M}calculated-column-reading-results-search-input-instances-in-a`,
			]);
		}
	});

	it("reading the search's results in a menu whose search launches by itself is the expression's own reading", async () => {
		const reading = await readCalculated(
			"count(instance('results')/results/case)",
			true,
		);
		expect(closedCodes(reading)).not.toContain(
			`${M}calculated-column-reading-results-search-input-instances-in-a`,
		);
	});

	it("reading the case's own property is held", async () => {
		const reading = await readColumn({
			useXpathExpression: true,
			field: "concat(notes, '!')",
		});
		expect(closedCodes(reading)).toEqual([]);
	});
});

describe("a sort calculation row", () => {
	it("names a wildcard that cannot identify one value on the selected case", async () => {
		const reading = await readDetails((short) => {
			short.sort_elements = [
				{
					field: "",
					type: "plain",
					direction: "ascending",
					blanks: "first",
					display: { en: "" },
					sort_calculation: "*",
					doc_type: "SortElement",
				},
			];
		});
		expect(closedCodes(reading)).toEqual([
			`${M}sort-calculation-without-a-typed-value`,
		]);
	});

	it("names a distance rule whose empty property leaves the worker no position", async () => {
		const reading = await readDetails((short) => {
			short.sort_elements = [
				{
					field: "",
					type: "distance",
					direction: "ascending",
					blanks: "first",
					display: { en: "" },
					sort_calculation: "notes",
					doc_type: "SortElement",
				},
			];
		});
		expect(closedCodes(reading)).toEqual([
			`${M}distance-sort-without-a-location-field`,
		]);
	});
});
