/**
 * Contract: the sort elements CommCare HQ's pages write that Nova would write otherwise read by
 * their rows: a sort-only element becomes a hidden column, among the list's fields and ahead of a
 * detail-only column over the same property that stays off the list; an unsorted list whose first column is `invisible`
 * gives that column the rule HQ's build applies; of two elements with one `field` the later
 * stands; `type: "string"` reads as Nova's derived word; a label on a sort-only element is the
 * name of the hidden column's rule in Sort by, read on the column only Details shows over its
 * property where there is one, and a label beside an `invisible` column names it by that column's
 * header, which HQ's build shows there, and where that header is blank in every language, by no
 * name, recording the blank entry the first publish drops from Android's Sort by.
 * Each same-state reading records its first-publish row.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { type BlueprintDoc, type Column, proseText } from "@/lib/domain";
import {
	calculatedColumn,
	columnSort,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	plainColumn,
} from "@/lib/domain/modules";
import { DERIVED_WIRE_IDENTITY } from "../../../wireIdentity";
import { namingFromHqPages } from "../../__tests__/hqPageNames";
import { matchingResolver } from "../../identity";
import { externalIdentityMap } from "../../identityMap";
import { patients, uuid } from "./fixtures";
import {
	type AppJson,
	closedCodes,
	codes,
	comparableList,
	emittedApp,
	listOf,
	readLists as readListsOf,
} from "./listReading";

const readLists = namingFromHqPages(readListsOf);

const element = (field: string, extra: Record<string, unknown> = {}) => ({
	doc_type: "SortElement",
	field,
	type: "plain",
	direction: "ascending",
	blanks: "",
	display: {},
	sort_calculation: "",
	...extra,
});

function registers(reading: Awaited<ReturnType<typeof readLists>>): string[] {
	return reading.ctx.facts.sameStateRewrites.map((one) => one.register);
}

describe("CommCare HQ's sort elements", () => {
	it("keeps independent calculations and the named field in worker order without showing extra columns", async () => {
		const doc = patients([plainColumn(uuid(1), "notes", "Notes")]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (!short) throw new Error("Missing short detail");
				short.sort_elements = [
					element("", {
						sort_calculation: "notes",
						type: "int",
						direction: "descending",
					}),
					element("", { sort_calculation: "'a'", display: { en: "Priority" } }),
					element("notes", { type: "int" }),
					element("", {
						sort_calculation: "notes",
						type: "double",
						display: { en: "Visit number" },
					}),
				];
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		const config = listOf(reading);
		expect(config.columns.map((column) => column.header)).toEqual(["Notes"]);
		expect(
			config.calculatedSorts?.map((rule) => [rule.priority, rule.label]),
		).toEqual([
			[2, "Visit number"],
			[0, "Priority"],
		]);
		expect(config.calculatedSorts?.[0]?.expression).not.toEqual(
			config.calculatedSorts?.[1]?.expression,
		);
		expect(registers(reading)).not.toContain("sort-rule-kept-as-hidden-column");
		const written = await emittedApp(reading.ctx.doc as BlueprintDoc);
		expect(
			written.modules[0]?.case_details.short.sort_elements.map((rule) => [
				rule.field,
				rule.sort_calculation,
				rule.type,
				(rule.display as Record<string, string>).en,
			]),
		).toEqual([
			["", "notes", "double", "Visit number"],
			["", "'a'", "plain", "Priority"],
			["notes", "", "int", ""],
			["", "notes", "double", "Visit number"],
		]);
		const canonical = await readLists(reading.ctx.doc as BlueprintDoc);
		expect(closedCodes(canonical)).toEqual([]);
		expect(
			canonical.ctx.facts.sameStateRewrites.filter((fact) =>
				fact.entry.endsWith("/sort-elements-sharing-a-join-text"),
			),
		).toEqual([]);
	});

	it("retains two differently named choices over the same calculated value", async () => {
		const doc = patients([plainColumn(uuid(1), "notes", "Notes")]);
		const first = await readLists(doc, {
			edit: (app) => {
				app.modules[0].case_details.short.sort_elements = [
					element("", {
						sort_calculation: "notes",
						display: { en: "Earlier visits" },
					}),
					element("", {
						sort_calculation: "(notes)",
						direction: "descending",
						display: { en: "Later visits" },
					}),
				];
			},
		});
		expect(closedCodes(first)).toEqual([]);
		const config = listOf(first);
		expect(config.calculatedSorts?.map((rule) => rule.label)).toEqual([
			"Earlier visits",
			"Later visits",
		]);
		const emitted = await emittedApp(first.ctx.doc as BlueprintDoc);
		expect(
			emitted.modules[0].case_details.short.sort_elements.map(
				(rule) => rule.sort_calculation,
			),
		).toEqual(["notes", "(notes)"]);
	});

	it("keeps each calculation's identity across a move and an HQ spelling edit", async () => {
		const doc = patients([plainColumn(uuid(1), "notes", "Notes")]);
		const first = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0].case_details.short;
				short.sort_elements = [
					element("", {
						sort_calculation: "notes",
						display: { en: "Visit order" },
					}),
					element("notes"),
					element("", { sort_calculation: "'A'", display: { en: "Alphabet" } }),
				];
			},
		});
		expect(closedCodes(first)).toEqual([]);
		const adopted = first.ctx.doc;
		if (!adopted) throw new Error("Missing adopted document");
		const expected = Object.fromEntries(
			(listOf(first).calculatedSorts ?? []).map((rule) => [
				rule.label,
				rule.uuid,
			]),
		);
		const reread = await readLists(adopted, {
			input: (base) => ({
				...base,
				resolver: matchingResolver(
					adopted.appId,
					externalIdentityMap(adopted, DERIVED_WIRE_IDENTITY),
				),
			}),
			edit: (app) => {
				const short = app.modules[0].case_details.short;
				short.sort_elements.reverse();
				short.sort_elements[0].sort_calculation = '  ("A") ';
			},
		});
		expect(closedCodes(reread)).toEqual([]);
		const sorts = listOf(reread).calculatedSorts ?? [];
		expect(sorts.map((rule) => [rule.label, rule.uuid, rule.priority])).toEqual(
			[
				["Alphabet", expected.Alphabet, 0],
				["Visit order", expected["Visit order"], 2],
			],
		);
	});

	it("reads a sort-only element as a hidden column, beside a detail-only column that stays off the list", async () => {
		const doc = patients([
			plainColumn(uuid(1), "case_name", "Name"),
			plainColumn(uuid(2), "phone", "Phone", {
				visibleInList: false,
				notOnList: true,
			}),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined) short.sort_elements = [element("phone")];
			},
			firstPassOnly: true,
		});
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: Record<string, unknown>[];
		};
		expect(
			read.list.map((column) => [
				column.field,
				column.visibleInList,
				column.visibleInDetail,
				column.notOnList,
				column.sort,
			]),
		).toEqual([
			// The hidden column is one of the list's fields, so it stands ahead of the column only
			// Details shows, as a re-read of Nova's own export gives it (`columnsOffAScreenLast`).
			["case_name", undefined, undefined, undefined, undefined],
			["phone", false, false, undefined, columnSort("asc", 0)],
			["phone", false, undefined, true, undefined],
		]);
		expect(registers(reading)).toContain("sort-rule-kept-as-hidden-column");
	});

	it("gives an unsorted list's invisible first column HQ's default rule", async () => {
		const doc = patients([
			plainColumn(uuid(1), "notes", "Notes", { visibleInList: false }),
			plainColumn(uuid(2), "case_name", "Name"),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined) short.sort_elements = [];
			},
		});
		// Read through the settle: Nova's projection writes the one element HQ's build defaults to,
		// which the comparison accepts as the source's empty list.
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: Record<string, unknown>[];
		};
		expect(read.list[0]?.sort).toEqual(columnSort("asc", 0));
		expect(registers(reading)).toContain("list-settings-respelled");
		const written = await emittedApp(reading.ctx.doc as BlueprintDoc);
		expect(
			written.modules[0]?.case_details.short.sort_elements.map((one) => [
				one.field,
				one.direction,
			]),
		).toEqual([["notes", "ascending"]]);
	});

	it("keeps Android's first-insertion order for hidden property choices when the last rule sets their priority", async () => {
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")]);
		const reading = await readLists(doc, {
			edit: (app) => {
				app.modules[0].case_details.short.sort_elements = [
					element("phone", { display: { en: "Outdated phone label" } }),
					element("notes", { display: { en: "Notes" } }),
					element("phone", {
						display: { en: "Phone" },
						direction: "descending",
					}),
				];
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		const output = (await emittedApp(reading.ctx.doc as BlueprintDoc))
			.modules[0].case_details.short;
		expect(output.columns.map((column) => column.field)).toEqual([
			"name",
			"phone",
			"notes",
		]);
		expect(
			output.sort_elements.map((rule) => [rule.field, rule.direction]),
		).toEqual([
			["notes", "ascending"],
			["phone", "descending"],
		]);
	});

	it("keeps hidden choices in their native tile menu positions after changing their default priorities", async () => {
		const doc = patients(
			[
				plainColumn(uuid(1), "case_name", "Name", {
					tile: {
						x: 0,
						y: 0,
						width: 12,
						height: 1,
						horizontalAlign: "left",
						verticalAlign: "top",
						fontSize: "medium",
					},
				}),
			],
			{ list: { tile: {} } },
		);
		const reading = await readLists(doc, {
			edit: (app) => {
				app.modules[0].case_details.short.sort_elements = [
					element("phone", { display: { en: "Old phone label" } }),
					element("notes", { display: { en: "Notes" } }),
					element("phone", {
						display: { en: "Phone" },
						direction: "descending",
					}),
				];
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		const output = (await emittedApp(reading.ctx.doc as BlueprintDoc))
			.modules[0].case_details.short;
		expect(output.columns.map((column) => column.field)).toEqual(["name"]);
		expect(
			output.sort_elements.map((rule) => [rule.field, rule.direction]),
		).toEqual([
			["phone", "descending"],
			["notes", "ascending"],
			["phone", "descending"],
		]);
		const reread = await readLists(reading.ctx.doc as BlueprintDoc);
		expect(closedCodes(reread)).toEqual([]);
		expect(
			reread.ctx.facts.sameStateRewrites.filter((fact) =>
				fact.entry.endsWith("/sort-elements-sharing-a-join-text"),
			),
		).toEqual([]);
	});

	it("reads the later of two elements with one field and drops the earlier", async () => {
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined)
					short.sort_elements = [
						element("name"),
						element("name", { direction: "descending" }),
					];
			},
		});
		expect(codes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: Record<string, unknown>[];
		};
		expect(read.list[0]?.sort).toEqual(columnSort("desc", 0));
		expect(registers(reading)).toContain("list-settings-respelled");
	});

	it("reads `type: string` as Nova's derived word and records it", async () => {
		const doc = patients([
			plainColumn(uuid(1), "case_name", "Name", { sort: columnSort("asc", 0) }),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				const first = short?.sort_elements[0];
				if (first !== undefined) first.type = "string";
			},
		});
		expect(codes(reading)).toEqual([]);
		// The column is on the list and stays there: only the stored word is new.
		expect(registers(reading)).toContain("list-settings-respelled");
		expect(registers(reading)).not.toContain("sort-rule-kept-as-hidden-column");
	});

	it("reads a label on a sort-only element as the name in Sort by of a column shown nowhere", async () => {
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined)
					short.sort_elements = [
						element("notes", {
							direction: "descending",
							display: { en: "Notes" },
						}),
					];
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: Record<string, unknown>[];
		};
		// The appended column's header is the label, the only place HQ's build prints it.
		expect(read.list.at(-1)).toMatchObject({
			field: "notes",
			header: "Notes",
			visibleInList: false,
			visibleInDetail: false,
			sort: columnSort("desc", 0, undefined, "Notes"),
		});
		expect(registers(reading)).toContain("sort-rule-kept-as-hidden-column");
	});

	it("reads a sort-only element's label on the column only Details shows over its property", async () => {
		const doc = patients([
			plainColumn(uuid(1), "case_name", "Name"),
			plainColumn(uuid(2), "notes", "Patient notes", {
				visibleInList: false,
				notOnList: true,
			}),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined)
					short.sort_elements = [
						element("notes", { display: { en: "Notes" } }),
					];
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: Record<string, unknown>[];
		};
		// One column, on the list hidden from Results and on Details under its own header.
		expect(
			read.list.map((column) => [
				column.field,
				column.header,
				column.visibleInList,
				column.visibleInDetail,
				column.notOnList,
				column.sort,
			]),
		).toEqual([
			["case_name", "Name", undefined, undefined, undefined, undefined],
			[
				"notes",
				"Patient notes",
				false,
				undefined,
				undefined,
				columnSort("asc", 0, undefined, "Notes"),
			],
		]);
	});

	it("reads a label beside an invisible column as its name in Sort by, the column's own header", async () => {
		const doc = patients([
			plainColumn(uuid(1), "case_name", "Name"),
			plainColumn(uuid(2), "notes", "Notes", {
				visibleInList: false,
				visibleInDetail: false,
				sort: columnSort("asc", 0),
			}),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short === undefined) return;
				const invisible = short.columns[1];
				if (invisible !== undefined) invisible.header = { en: "Latest notes" };
				short.sort_elements = [
					element("notes", { display: { en: "Shown nowhere" } }),
				];
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: Record<string, unknown>[];
		};
		expect(read.list[1]).toMatchObject({
			header: "Latest notes",
			sort: columnSort("asc", 0, undefined, "Latest notes"),
		});
		// The entry keeps its name, so nothing a worker sees in Sort by moves.
		expect(registers(reading)).not.toContain(
			"sort-by-entry-with-a-blank-name-dropped",
		);
	});

	// HQ's build lists the column under its header (`detail_screen.py::Invisible.header`), which it
	// writes as a no-break space (`commcare_translations.py::dumps`), so Android's Sort by shows an
	// entry that looks blank; Nova holds no name there, so the first publish drops it.
	it("reads a label beside an invisible column with a blank header as no name, and records the blank Sort by entry the first publish drops", async () => {
		const doc = patients([
			plainColumn(uuid(1), "case_name", "Name"),
			plainColumn(uuid(2), "notes", "", {
				visibleInList: false,
				visibleInDetail: false,
				sort: columnSort("asc", 0),
			}),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined)
					short.sort_elements = [
						element("notes", { display: { en: "Notes" } }),
					];
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: Record<string, unknown>[];
		};
		expect(read.list[1]?.sort).toEqual(columnSort("asc", 0));
		expect(
			reading.ctx.facts.sameStateRewrites
				.filter((one) => one.path.endsWith("/sort_elements/0/display"))
				.map((one) => one.register),
		).toEqual(["sort-by-entry-with-a-blank-name-dropped"]);
	});

	// HQ's build writes a sort-only element's label only where some stored value is not blank to
	// Python (`SortElement.has_display_values`, `s.strip() != ''`), which is not JavaScript's trim:
	// U+001F is a space to Python and not to JavaScript, U+FEFF the other way round.
	it("reads a label of characters Python reads as spaces as no label, as HQ's build does", async () => {
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")]);
		const sortOnly = (display: Record<string, string>) =>
			readLists(doc, {
				edit: (app) => {
					const short = app.modules[0]?.case_details.short;
					if (short !== undefined)
						short.sort_elements = [element("notes", { display })];
				},
			});
		const spaces = await sortOnly({ en: "\u001f \u2003" });
		const none = await sortOnly({});
		// Read whole, with nothing left unclaimed, and the label claimed as HQ's derived blank.
		expect(closedCodes(spaces)).toEqual([]);
		expect(
			[...spaces.ctx.close().claims.records()]
				.filter((record) => record.key === "schema:SortElement.display")
				.map((record) => record.entry),
		).toEqual(["menus-and-case-lists/display"]);
		// The same list as a sort-only element with no label: a hidden column, last, that sorts.
		expect(comparableList(listOf(spaces))).toEqual(
			comparableList(listOf(none)),
		);
		const read = comparableList(listOf(spaces)) as {
			list: Record<string, unknown>[];
		};
		expect(read.list.at(-1)?.sort).toEqual(columnSort("asc", 0));
	});

	it("holds a label of a character Python does not read as a space, which HQ's build writes", async () => {
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined)
					short.sort_elements = [
						element("notes", { display: { en: "\ufeff" } }),
					];
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		const read = comparableList(listOf(reading)) as {
			list: Record<string, unknown>[];
		};
		expect(read.list.at(-1)?.sort).toEqual(
			columnSort("asc", 0, undefined, "\ufeff"),
		);
	});

	it("declares `int` on a property no writer types, so the plan derives the stored comparator", async () => {
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined)
					short.sort_elements = [element("visits", { type: "int" })];
			},
		});
		expect(codes(reading)).toEqual([]);
		const visits = reading.ctx.doc?.caseTypes
			?.find((type) => type.name === "patient")
			?.properties.find((property) => property.name === "visits");
		expect(visits?.data_type).toBe("int");
		const read = comparableList(listOf(reading)) as {
			list: Record<string, unknown>[];
		};
		expect(read.list.map((column) => [column.field, column.sort])).toEqual([
			["case_name", undefined],
			["visits", columnSort("asc", 0)],
		]);
	});

	it("keeps an Android distance rule through the source read and its next HQ upload", async () => {
		const doc = patients([
			plainColumn(uuid(1), "notes", "Coordinates", {
				sort: columnSort("asc", 0),
			}),
		]);
		const reading = await readLists(
			{ ...doc, appSettings: { ...doc.appSettings, runsOnlyOn: "android" } },
			{
				edit: (app) => {
					const first = app.modules[0]?.case_details.short.sort_elements[0];
					if (first) first.type = "distance";
				},
			},
		);
		expect(closedCodes(reading)).toEqual([]);
		expect(listOf(reading).columns[0]?.sort?.comparator).toBe("distance");
		const written = await emittedApp(reading.ctx.doc as BlueprintDoc);
		expect(written.modules[0]?.case_details.short.sort_elements[0]?.type).toBe(
			"distance",
		);
	});

	it("keeps a whole-number comparison on a property a text question saves", async () => {
		const doc = patients([
			plainColumn(uuid(1), "notes", "Notes", { sort: columnSort("asc", 0) }),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const first = app.modules[0]?.case_details.short.sort_elements[0];
				if (first !== undefined) first.type = "int";
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(
			listOf(reading)?.columns.find((column) => column.sort)?.sort?.comparator,
		).toBe("integer");
		expect(
			[...reading.ctx.close().claims.records()].map((record) => record.entry),
		).toContain(
			"menus-and-case-lists/type-int-or-double-differing-from-the-derived-type-on-a-column",
		);
		const written = await emittedApp(reading.ctx.doc as BlueprintDoc);
		expect(written.modules[0]?.case_details.short.sort_elements[0]?.type).toBe(
			"int",
		);
	});

	for (const [stored, property] of [
		["name", "case_name"],
		["date-opened", "date_opened"],
		["external-id", "external_id"],
	] as const)
		it(`reads a sort-only element on HQ's \`${stored}\` as a hidden column over \`${property}\``, async () => {
			const doc = patients([plainColumn(uuid(1), "notes", "Notes")]);
			const reading = await readLists(doc, {
				edit: (app) => {
					const short = app.modules[0]?.case_details.short;
					if (short !== undefined) short.sort_elements = [element(stored)];
				},
			});
			expect(codes(reading)).toEqual([]);
			const read = comparableList(listOf(reading)) as {
				list: Record<string, unknown>[];
			};
			expect(read.list.map((column) => [column.field, column.sort])).toEqual([
				["notes", undefined],
				[property, columnSort("asc", 0)],
			]);
		});
});

/** One menu of patients whose registration saves `visits` from a whole-number question. */
function withVisits(columns: Column[]): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name" },
					{ name: "visits", label: "Visits" },
				],
			},
		],
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
								kind: "int",
								id: "visits",
								caseWrite: { caseType: "patient", property: "visits" },
							}),
						],
					},
				],
				caseListConfig: { columns, searchInputs: [] },
			},
		],
	});
}

/**
 * Contract: HQ's build compares a sort element's `plain`, `date` or `string` type, and its default
 * element, as text, where Nova's derived comparator over a whole-number property is a number, so
 * the two order `1, 10, 2` and `1, 2, 10`; such an element is a finding, except on a column whose
 * format sorts by its own type, which reads no element's type. The failure it catches: a list
 * read with no finding whose first publish reorders it.
 */
describe("a text comparison over a whole-number property", () => {
	it("prints `int` for Nova's rule", async () => {
		const doc = withVisits([
			plainColumn(uuid(1), "visits", "Visits", { sort: columnSort("asc", 0) }),
		]);
		const app = await emittedApp(doc);
		expect(app.modules[0]?.case_details.short.sort_elements[0]?.type).toBe(
			"int",
		);
	});

	// Core's `DetailFieldParser` compares every word but `int` and `double` as text, and HQ writes
	// a word it does not map as it is (`FormattedDetailColumn.sort_node`).
	for (const type of ["plain", "date", "string", "", "integer", "number"])
		it(`keeps the textual order of a stored \`${type || "none"}\` element`, async () => {
			const doc = withVisits([
				plainColumn(uuid(1), "visits", "Visits", {
					sort: columnSort("asc", 0),
				}),
			]);
			const reading = await readLists(doc, {
				edit: (app) => {
					const first = app.modules[0]?.case_details.short.sort_elements[0];
					if (first !== undefined) first.type = type;
				},
			});
			expect(closedCodes(reading)).toEqual([]);
			expect(
				listOf(reading)?.columns.find((column) => column.sort)?.sort
					?.comparator,
			).toBe("text");
			const written = await emittedApp(reading.ctx.doc as BlueprintDoc);
			expect(
				written.modules[0]?.case_details.short.sort_elements[0]?.type,
			).toBe("plain");
		});

	it("holds a word HQ's page does not offer over a text property, as Nova's derived word", async () => {
		const doc = patients([
			plainColumn(uuid(1), "case_name", "Name", { sort: columnSort("asc", 0) }),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const first = app.modules[0]?.case_details.short.sort_elements[0];
				if (first !== undefined) first.type = "integer";
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(registers(reading)).toContain("list-settings-respelled");
		expect(registers(reading)).not.toContain("sort-rule-kept-as-hidden-column");
		const written = await emittedApp(reading.ctx.doc as BlueprintDoc);
		expect(written.modules[0]?.case_details.short.sort_elements[0]?.type).toBe(
			"plain",
		);
	});

	it("leaves a type that is no text for the close to name", async () => {
		const doc = patients([
			plainColumn(uuid(1), "case_name", "Name", { sort: columnSort("asc", 0) }),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const first = app.modules[0]?.case_details.short.sort_elements[0];
				if (first !== undefined) (first as { type: unknown }).type = 5;
			},
		});
		expect(closedCodes(reading)).toContain(
			"unrecognized:schema:SortElement.type",
		);
	});

	it("keeps HQ's default text order over a hidden numeric first column", async () => {
		const doc = withVisits([
			plainColumn(uuid(1), "visits", "Visits", { visibleInList: false }),
			plainColumn(uuid(2), "case_name", "Name"),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined) short.sort_elements = [];
			},
		});
		expect(closedCodes(reading)).toEqual([]);
		expect(
			listOf(reading)?.columns.find((column) => column.sort)?.sort?.comparator,
		).toBe("text");
		const written = await emittedApp(reading.ctx.doc as BlueprintDoc);
		expect(written.modules[0]?.case_details.short.sort_elements[0]?.type).toBe(
			"plain",
		);
	});

	it("holds any stored type on an ID mapping, whose format sorts by its own", async () => {
		for (const type of ["plain", "int"]) {
			const doc = withVisits([
				idMappingColumn(
					uuid(1),
					"visits",
					"Visits",
					[idMappingEntry("1", "One"), idMappingEntry("2", "Two")],
					{ sort: columnSort("asc", 0) },
				),
			]);
			const reading = await readLists(doc, {
				edit: (app) => {
					const first = app.modules[0]?.case_details.short.sort_elements[0];
					if (first !== undefined) first.type = type;
				},
			});
			expect(codes(reading)).toEqual([]);
		}
	});
});

/**
 * Contract: a sort element's `field` passes CommCare HQ's own check where a column's does
 * (`details/utils.js::isValidPropertyName`, `_validate_detail_screen_field`), and HQ's build reads
 * it as the column it appends reads it, so each field is the row of that column's field. The
 * failure it catches: a relation path HQ builds told to be fixed in HQ as an invalid field.
 */
describe("a sort element's field that is no one word", () => {
	for (const [field, entry] of [
		[
			"parent/case_id",
			"menus-and-case-lists/case-id-as-a-property-column-s-field",
		],
		["user/district", "menus-and-case-lists/user-prop-usercase"],
		["#owner_name", "menus-and-case-lists/owner-name"],
		["ledger:stock", "menus-and-case-lists/ledger-section"],
		["case_id", "menus-and-case-lists/case-id-as-a-property-column-s-field"],
		[
			"1visits",
			"menus-and-case-lists/field-failing-details-utils-js-isvalidpropertyname-non",
		],
	] as const)
		it(`reads \`${field}\` by its column field's row`, async () => {
			const doc = patients([plainColumn(uuid(1), "case_name", "Name")]);
			const reading = await readLists(doc, {
				edit: (app) => {
					const short = app.modules[0]?.case_details.short;
					if (short !== undefined) short.sort_elements = [element(field)];
				},
				firstPassOnly: true,
			});
			expect(codes(reading)).toEqual([entry]);
		});
});

/**
 * Contract: a `sort_calculation` beside a `field` is inert only on a column whose stored list
 * format sorts by its own expression (`FormattedDetailColumn.sort_node`); a column hidden from
 * Results is `invisible` on the list whatever its detail partner shows, and HQ sorts it by the
 * calculation. The failure it catches: the calculation dropped as inert because the joined
 * column is a date, and the first publish sorting by the raw property.
 */
describe("a sort calculation beside a field", () => {
	const dob = (shown: boolean) =>
		patients([
			plainColumn(uuid(1), "case_name", "Name"),
			dateColumn(uuid(2), "dob", "Born", "%d/%m/%Y", {
				...(!shown && { visibleInList: false }),
				sort: columnSort("asc", 0),
			}),
		]);
	const withCalculation = (app: AppJson) => {
		const first = app.modules[0]?.case_details.short.sort_elements[0];
		if (first !== undefined) first.sort_calculation = "if(dob = '', 0, 1)";
	};

	it("is refused on a column hidden from Results whose detail shows a date", async () => {
		const reading = await readLists(dob(false), { edit: withCalculation });
		expect(codes(reading)).toContain(
			"menus-and-case-lists/field-and-a-differing-sort-calculation-on-any-other-column",
		);
	});

	it("is held on a date column Results shows", async () => {
		const reading = await readLists(dob(true), { edit: withCalculation });
		expect(codes(reading)).toEqual([]);
	});

	it("is held on an ID mapping, whose format sorts by its own", async () => {
		const reading = await readLists(
			patients([
				idMappingColumn(uuid(1), "notes", "Notes", [idMappingEntry("a", "A")], {
					sort: columnSort("asc", 0),
				}),
			]),
			{
				edit: (app) => {
					const first = app.modules[0]?.case_details.short.sort_elements[0];
					if (first !== undefined)
						first.sort_calculation = "string-length(notes)";
				},
			},
		);
		expect(codes(reading)).toEqual([]);
	});
});

describe("a rule on a column Nova writes by its choices' labels", () => {
	const visits = (column: Column) =>
		buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "village",
							label: proseText("village"),
							data_type: "single_select",
							options: [
								{ value: "north", label: proseText("North") },
								{ value: "south", label: proseText("South") },
							],
						},
					],
				},
			],
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
									id: "village",
									options: [
										{ value: "north", label: "North" },
										{ value: "south", label: "South" },
									],
									caseWrite: { caseType: "patient", property: "village" },
								}),
							],
						},
					],
					caseListConfig: {
						columns: [plainColumn(uuid(1), "case_name", "Name"), column],
						searchInputs: [],
					},
				},
			],
		});
	const sortFieldEntries = async (doc: BlueprintDoc) => {
		const reading = await readLists(doc);
		expect(closedCodes(reading)).toEqual([]);
		return {
			app: reading.app,
			entries: [...reading.ctx.close().claims.records()]
				.filter((record) => record.key === "schema:SortElement.field")
				.map((record) => record.entry),
		};
	};

	it("reads Nova's rule on a select property's label column as a sort on a translatable-enum column", async () => {
		const { app, entries } = await sortFieldEntries(
			visits(
				plainColumn(uuid(2), "village", "Village", {
					sort: columnSort("asc", 0),
				}),
			),
		);
		const short = app.modules[0]?.case_details.short;
		// Nova writes the column as its label projection and the rule by the column's place.
		expect(short?.columns[1]?.format).toBe("translatable-enum");
		expect(short?.sort_elements.map((one) => one.field)).toEqual([
			"_cc_calculated_1",
		]);
		expect(entries).toEqual([
			"menus-and-case-lists/sort-on-a-translatable-enum-column-nova-s-label-projection-of-a",
		]);
	});

	it("reads a rule on a calculated column of another format as a sort on a calculated column", async () => {
		const { app, entries } = await sortFieldEntries(
			visits(
				calculatedColumn(
					uuid(2),
					"Village again",
					{
						kind: "term",
						term: { kind: "prop", caseType: "patient", property: "village" },
					},
					{ sort: columnSort("asc", 0) },
				),
			),
		);
		const short = app.modules[0]?.case_details.short;
		expect(short?.columns[1]?.format).toBe("plain");
		expect(entries).toEqual(["menus-and-case-lists/field-cc-calculated-n"]);
	});
});
