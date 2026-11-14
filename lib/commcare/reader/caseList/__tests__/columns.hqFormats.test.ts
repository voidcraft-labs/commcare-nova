/**
 * Contract: each column format CommCare HQ's page offers reads or raises as its manifest row
 * says, and a finding names the format by the label HQ's page shows. The failure it catches: a
 * format Nova cannot write back read as held. Each case edits Nova's emission at the keys HQ's
 * Case List page (`static/app_manager/js/details/bootstrap5/column.js`) writes.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { namingFromHqPages } from "../../__tests__/hqPageNames";
import { patients, uuid } from "./fixtures";
import {
	type AppJson,
	closedCodes,
	codes,
	comparableList,
	type Detail,
	listOf,
	readLists as readListsOf,
} from "./listReading";

const M = "menus-and-case-lists/";

const readLists = namingFromHqPages(readListsOf);

const twoColumns = () =>
	patients([
		plainColumn(uuid(1), "case_name", "Name"),
		plainColumn(uuid(2), "notes", "Notes"),
	]);

/** Reads the list after `edit` changed its two stored details. */
async function readDetails(
	edit: (short: Detail, long: Detail, app: AppJson) => void,
	firstPassOnly = true,
) {
	return readLists(twoColumns(), {
		edit: (app) => {
			const pair = app.modules[0]?.case_details;
			if (pair !== undefined) edit(pair.short, pair.long, app);
		},
		firstPassOnly,
	});
}

/** Reads the list after the second column of `screens` took `change`. */
async function readFormat(
	change: Record<string, unknown>,
	screens: readonly ("short" | "long")[] = ["short", "long"],
) {
	return readDetails((short, long) => {
		for (const screen of screens) {
			const column = (screen === "short" ? short : long).columns[1];
			if (column !== undefined) Object.assign(column, change);
		}
	});
}

/** A copy of the second column of `detail` with `change`, appended. */
function addColumn(detail: Detail, change: Record<string, unknown>): void {
	const second = detail.columns[1];
	if (second !== undefined) detail.columns.push({ ...second, ...change });
}

describe("CommCare HQ's column formats", () => {
	const findings: [string, Record<string, unknown>, string][] = [
		[
			"late-flag",
			{ format: "late-flag", late_flag: 30 },
			`${M}6-late-flag-late-flag-1`,
		],
		[
			"late-flag of 0",
			{ format: "late-flag", late_flag: 0 },
			`${M}6p-late-flag-late-flag-0`,
		],
		[
			"time-ago over a menu interval",
			{ format: "time-ago", time_ago_interval: 7 },
			`${M}3-time-ago-time-ago-interval-the-7-menu-values-years-months`,
		],
		[
			"time-ago over months until",
			{ format: "time-ago", time_ago_interval: -365.25 / 12 },
			`${M}3-time-ago-time-ago-interval-the-7-menu-values-years-months`,
		],
		[
			"time-ago over another interval",
			{ format: "time-ago", time_ago_interval: 3 },
			`${M}3p-time-ago-other-interval`,
		],
		["address", { format: "address" }, `${M}8-address`],
		["distance", { format: "distance" }, `${M}9-distance`],
		["picture", { format: "picture" }, `${M}17-picture`],
		["audio", { format: "audio" }, `${M}18-audio`],
		["graph", { format: "graph" }, `${M}22-graph`],
		["image", { format: "image" }, `${M}23-image-cc-case-image`],
		["address-popup", { format: "address-popup" }, `${M}15-address-popup`],
		[
			"conditional-enum",
			{ format: "conditional-enum" },
			`${M}20-conditional-enum`,
		],
		[
			"a date pattern Core does not format",
			{ format: "date", date_format: "%Q" },
			`${M}2p-date-any-other-date-format`,
		],
		[
			"an enum key holding a space",
			{ format: "enum", enum: [{ key: "a b", value: { en: "A" } }] },
			`${M}5pp-enum-key-that-is-empty-or-holds-whitespace`,
		],
		[
			"an enum key holding &",
			{ format: "enum", enum: [{ key: "a&b", value: { en: "A" } }] },
			`${M}5p-enum-key-containing`,
		],
		[
			"an enum key holding <",
			{ format: "enum", enum: [{ key: "a<b", value: { en: "A" } }] },
			`${M}5p-enum-key-containing`,
		],
		[
			"two enum entries of one key",
			{
				format: "enum",
				enum: [
					{ key: "a", value: { en: "A" } },
					{ key: "a", value: { en: "B" } },
				],
			},
			`${M}an-enum-enum-image-conditional-enum-or-translatable-enum-column`,
		],
		[
			"an icon map whose keys are plain values",
			{ format: "enum-image", enum: [{ key: "a", value: { en: "" } }] },
			`${M}19-enum-image-whose-keys-are-plain-values`,
		],
		[
			"an icon map whose keys are conditions of another form",
			{ format: "enum-image", enum: [{ key: ". = 'a'", value: { en: "" } }] },
			`${M}19pp-enum-image-whose-keys-are-conditions-of-any-other-form-dot`,
		],
		[
			"a non-calculated translatable-enum over the case's property",
			{
				format: "translatable-enum",
				enum: [{ key: "a", value: { en: "A" } }],
			},
			`${M}translatable-enum-on-a-column-that-is-not-a-calculated-property-over-a-property`,
		],
		[
			"a non-calculated translatable-enum over a relation in a menu that does not search",
			{
				format: "translatable-enum",
				field: "parent/notes",
				enum: [{ key: "a", value: { en: "A" } }],
			},
			`${M}translatable-enum-on-a-column-that-is-not-a-calculated-property-relation-does`,
		],
		[
			"a translatable-enum key outside the editor's grammar",
			{
				format: "translatable-enum",
				enum: [{ key: "a.b", value: { en: "A" } }],
			},
			`${M}21p-translatable-enum-key-outside-a-za-z0-9`,
		],
		[
			"a calculated translatable-enum outside Nova's two projections",
			{
				format: "translatable-enum",
				useXpathExpression: true,
				field: "concat(notes, 'x')",
				enum: [{ key: "a", value: { en: "A" } }],
			},
			`${M}21-translatable-enum-outside-nova-s-two-projections`,
		],
		["a product column", { model: "product" }, `${M}model-product`],
		[
			"a relation path",
			{ field: "parent/notes" },
			`${M}idx-prop-parent-host-any-index-names-other-than-a-first-step`,
		],
		["the owner's name", { field: "#owner_name" }, `${M}owner-name`],
		[
			"markdown outside the link shape",
			{ format: "markdown" },
			`${M}10-markdown-outside-the-link-shape`,
		],
	];
	for (const [name, change, entry] of findings)
		it(`raises ${name}`, async () => {
			const reading = await readFormat(change);
			expect(codes(reading)).toContain(entry);
		});

	it("raises a plain column over a property a select question saves", async () => {
		const doc = buildDoc({
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "name",
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "single_select",
									id: "risk",
									caseWrite: { caseType: "patient", property: "risk" },
									optionsSource: {
										kind: "inline",
										options: [
											{
												value: "low",
												label: proseText("Low"),
												uuid: testUuid("o-low"),
											},
										],
									},
								}),
							],
						},
					],
					caseListConfig: {
						columns: [plainColumn(uuid(1), "case_name", "Name")],
						searchInputs: [],
					},
				},
			],
		});
		// HQ's plain column shows the stored value; Nova's plain column over the property would show
		// the choice's label.
		const reading = await readLists(doc, {
			edit: (app) => {
				const pair = app.modules[0]?.case_details;
				for (const detail of [pair?.short, pair?.long]) {
					const column = detail?.columns[0];
					if (column !== undefined)
						detail?.columns.push({ ...column, field: "risk" });
				}
			},
			firstPassOnly: true,
		});
		expect(codes(reading)).toContain(
			`${M}1p-plain-over-a-property-select-questions-write`,
		);
	});

	it("names a late flag by the label HQ's page shows", async () => {
		const reading = await readFormat({ format: "late-flag", late_flag: 30 });
		const finding = reading.findings.find(
			(one) => one.code === `${M}6-late-flag-late-flag-1`,
		);
		expect(finding?.detail.name).toBe("Late Flag");
	});

	it("reads a slug HQ registers no format for as a plain column", async () => {
		const reading = await readFormat({ format: "calculate" });
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { kind: string; field: string }[];
		};
		expect(read.list[1]).toMatchObject({ kind: "plain", field: "notes" });
	});

	it("reads HQ's renamed names as Nova's standard properties", async () => {
		const reading = await readFormat({ field: "date-opened" });
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { field: string }[];
		};
		expect(read.list[1]?.field).toBe("date_opened");
	});
});

describe("geo formats", () => {
	it("raises a geo format on the list beside an address column", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short.columns[1] ?? {}, { format: "geo-boundary" });
			addColumn(short, { format: "address", field: "phone" });
		});
		expect(codes(reading)).toContain(`${M}11-geo-boundary`);
		expect(codes(reading)).not.toContain(
			`${M}a-geo-column-without-the-column-it-depends-on`,
		);
	});

	it("raises a geo format on the list without its address column", async () => {
		const reading = await readFormat({ format: "geo-points" }, ["short"]);
		expect(codes(reading)).toContain(
			`${M}a-geo-column-without-the-column-it-depends-on`,
		);
		expect(codes(reading)).not.toContain(
			`${M}13-geo-points-on-the-case-list-only`,
		);
	});

	it("raises a geo color format without the geo column it colors", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short.columns[1] ?? {}, { format: "geo-points-colors" });
			addColumn(short, { format: "address", field: "phone" });
		});
		expect(codes(reading)).toContain(
			`${M}a-geo-column-without-the-column-it-depends-on`,
		);
	});

	it("reads a geo format on the detail beside its address column as a plain column", async () => {
		const reading = await readDetails((_short, long) => {
			Object.assign(long.columns[1] ?? {}, { format: "geo-boundary" });
			addColumn(long, { format: "address", field: "phone" });
		});
		const found = codes(reading);
		// The address column is its own finding; the geo column is held.
		expect(found).toContain(`${M}8-address`);
		expect(found).not.toContain(
			`${M}a-geo-column-without-the-column-it-depends-on`,
		);
		expect(found).not.toContain(`${M}11-geo-boundary`);
	});

	it("raises a geo format on the detail without its address column", async () => {
		const reading = await readFormat({ format: "geo-boundary" }, ["long"]);
		expect(codes(reading)).toContain(
			`${M}a-geo-column-without-the-column-it-depends-on`,
		);
	});

	it("raises two geo columns of one format in a detail of a basic menu", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short.columns[1] ?? {}, { format: "geo-points" });
			addColumn(short, { format: "geo-points", field: "dob" });
			addColumn(short, { format: "address", field: "phone" });
		});
		expect(codes(reading)).toContain(
			`${M}more-than-one-address-column-or-more-than-one-image-or-geo`,
		);
		expect(codes(reading)).not.toContain(
			`${M}13-geo-points-on-the-case-list-only`,
		);
	});

	it("raises two address columns in a detail of a basic menu", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short.columns[1] ?? {}, { format: "address" });
			addColumn(short, { format: "address", field: "phone" });
		});
		expect(codes(reading)).toContain(
			`${M}more-than-one-address-column-or-more-than-one-image-or-geo`,
		);
	});
});

describe("clickable icons", () => {
	it("raises one on the list naming an entry point", async () => {
		const reading = await readFormat(
			{ format: "clickable-icon", endpoint_action_id: "open_visit" },
			["short"],
		);
		expect(codes(reading)).toContain(
			`${M}16-clickable-icon-endpoint-action-id-on-the-case-list`,
		);
	});

	it("raises one on the list with no entry point", async () => {
		const reading = await readFormat({ format: "clickable-icon" }, ["short"]);
		expect(codes(reading)).toContain(
			`${M}16p-clickable-icon-with-an-empty-endpoint-action-id-on-the-case`,
		);
	});

	it("raises one on the detail whatever its entry point", async () => {
		const reading = await readFormat(
			{ format: "clickable-icon", endpoint_action_id: "open_visit" },
			["long"],
		);
		expect(codes(reading)).toContain(
			`${M}16pp-clickable-icon-on-the-case-detail-whatever-its-endpoint`,
		);
	});
});

describe("a custom tile", () => {
	for (const format of ["invisible", "address"])
		it(`raises a ${format} column in it`, async () => {
			const reading = await readDetails((short) => {
				short.case_tile_template = "custom";
				Object.assign(short.columns[1] ?? {}, { format });
			});
			expect(codes(reading)).toContain(
				`${M}invisible-or-address-column-in-a-custom-tile`,
			);
			expect(codes(reading)).not.toContain(`${M}8-address`);
		});
});

describe("filter columns", () => {
	it("drops one that changes no build, and the list reads back without it", async () => {
		const reading = await readDetails((short, long) => {
			addColumn(short, { format: "filter", field: "dob" });
			addColumn(long, { format: "filter", field: "dob" });
		}, false);
		expect(closedCodes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: { field: string }[];
		};
		expect(read.list.map((column) => column.field)).toEqual([
			"case_name",
			"notes",
		]);
	});

	it("raises one that is the column HQ's default sort reads", async () => {
		const reading = await readDetails((short) => {
			short.columns.unshift({
				...(short.columns[0] ?? {}),
				format: "filter",
				field: "dob",
			});
		});
		expect(codes(reading)).toContain(`${M}24p-filter-otherwise`);
	});

	it("raises one whose field a sort element names", async () => {
		const reading = await readDetails((short) => {
			addColumn(short, { format: "filter", field: "dob" });
			short.sort_elements = [
				{ field: "dob", type: "string", direction: "ascending", blanks: "" },
			];
		});
		expect(codes(reading)).toContain(`${M}24p-filter-otherwise`);
	});
});

describe("every column's other keys", () => {
	it("holds Nova's own emission with every key claimed", async () => {
		const reading = await readDetails(() => {}, false);
		expect(closedCodes(reading)).toEqual([]);
	});

	it("drops the format extras HQ's editor saves on a column of another format", async () => {
		const reading = await readFormat({
			date_format: "%d/%m/%y",
			late_flag: 7,
			time_ago_interval: 7,
		});
		expect(closedCodes(reading)).toEqual([]);
	});

	it("raises a key no model declares, naming nothing", async () => {
		const reading = await readFormat({ planted_key: 1 }, ["short"]);
		const finding = reading.findings.find(
			(one) => one.code === `${M}any-other-undeclared-key`,
		);
		expect(finding).toBeDefined();
		expect(finding?.detail.name).toBeUndefined();
	});
});

describe("a detail's callout and tabs", () => {
	it("raises each key of a callout on the list by its own row", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short, {
				lookup_enabled: true,
				lookup_action: "org.example.SCAN",
				lookup_name: { en: "Scan" },
				lookup_extras: [{ key: "k", value: "v" }],
				lookup_responses: [{ key: "r" }],
			});
		});
		const found = codes(reading);
		expect(found).toContain(`${M}lookup-enabled-lookup-action`);
		expect(found).toContain(`${M}lookup-name`);
		expect(found).toContain(`${M}lookup-extras-key-value`);
		expect(found).toContain(`${M}lookup-responses-key`);
		expect(
			closedCodes(reading).filter((one) => one.startsWith("unrecognized")),
		).toEqual([]);
	});

	it("raises a callout with no responses before the rows of its keys", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short, {
				lookup_enabled: true,
				lookup_action: "org.example.SCAN",
				lookup_extras: [{ key: "k", value: "v" }],
			});
		});
		const found = codes(reading);
		expect(found).toContain(`${M}callout-with-no-extras-or-no-responses`);
		expect(found).not.toContain(`${M}lookup-extras-key-value`);
		expect(found).toContain(`${M}lookup-enabled-lookup-action`);
	});

	it("drops a callout on an icon_text_grid list", async () => {
		const reading = await readDetails((short) => {
			Object.assign(short, {
				case_tile_template: "icon_text_grid",
				lookup_enabled: true,
				lookup_action: "org.example.SCAN",
				lookup_name: { en: "Scan" },
			});
		});
		const found = closedCodes(reading);
		expect(found).toContain(`${M}detail-case-tile-template-icon-text-grid`);
		expect(found.filter((one) => one.includes("lookup"))).toEqual([]);
	});

	it("raises every kind of tab the detail holds", async () => {
		const reading = await readDetails((_short, long) => {
			long.tabs = [
				{ header: { en: "Main" }, starting_index: 1, relevant: "notes != ''" },
				{
					header: { en: "Kids" },
					starting_index: 2,
					has_nodeset: true,
					nodeset_case_type: "child",
				},
			];
		});
		const found = codes(reading);
		expect(found).toContain(`${M}columns-above-the-first-tab-when-tabs-exist`);
		expect(found).toContain(`${M}plain-tab-header-starting-index`);
		expect(found).toContain(
			`${M}data-tab-over-child-cases-has-nodeset-nodeset-case-type-nodeset`,
		);
		expect(found).toContain(`${M}tab-relevant-lifts-into-predicate-not`);
	});
});
