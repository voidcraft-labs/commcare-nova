/**
 * Contract: the sort elements CommCare HQ's pages write that Nova would write otherwise read by
 * their rows: a sort-only element becomes a hidden column, last, beside a detail-only column over
 * the same property that stays off the list; an unsorted list whose first column is `invisible`
 * gives that column the rule HQ's build applies; of two elements with one `field` the later
 * stands; `type: "string"` reads as Nova's derived word; a label on a sort-only element raises.
 * Each same-state reading records its first-publish row.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Column } from "@/lib/domain";
import {
	columnSort,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	plainColumn,
} from "@/lib/domain/modules";
import { namingFromHqPages } from "../../__tests__/hqPageNames";
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
			["case_name", undefined, undefined, undefined, undefined],
			["phone", false, undefined, true, undefined],
			["phone", false, false, undefined, columnSort("asc", 0)],
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

	it("reads the later of two elements with one field and drops the earlier", async () => {
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined)
					short.sort_elements = [
						element("case_name"),
						element("case_name", { direction: "descending" }),
					];
			},
			firstPassOnly: true,
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
		expect(registers(reading)).toContain("sort-rule-kept-as-hidden-column");
	});

	it("raises a label on a sort-only element", async () => {
		const doc = patients([plainColumn(uuid(1), "case_name", "Name")]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const short = app.modules[0]?.case_details.short;
				if (short !== undefined)
					short.sort_elements = [
						element("notes", { display: { en: "Notes" } }),
					];
			},
			firstPassOnly: true,
		});
		expect(codes(reading)).toContain(
			"menus-and-case-lists/display-lang-sort-by-label-on-a-sort-only-element",
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

	it("raises `int` on a property a text question saves", async () => {
		const doc = patients([
			plainColumn(uuid(1), "notes", "Notes", { sort: columnSort("asc", 0) }),
		]);
		const reading = await readLists(doc, {
			edit: (app) => {
				const first = app.modules[0]?.case_details.short.sort_elements[0];
				if (first !== undefined) first.type = "int";
			},
		});
		expect(codes(reading)).toContain(
			"menus-and-case-lists/type-int-or-double-differing-from-the-derived-type-on-a-column",
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

const TEXT_OVER_NUMBER =
	"menus-and-case-lists/type-plain-date-or-string-or-none-where-nova-derives-int-or-double";

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
		it(`raises a stored \`${type || "none"}\` element`, async () => {
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
			expect(codes(reading)).toContain(TEXT_OVER_NUMBER);
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
		expect(registers(reading)).toContain("sort-rule-kept-as-hidden-column");
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

	it("raises HQ's default element over a hidden first column", async () => {
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
		expect(codes(reading)).toContain(TEXT_OVER_NUMBER);
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
			"parent/village",
			"menus-and-case-lists/idx-prop-parent-host-any-index-names-other-than-a-first-step",
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
