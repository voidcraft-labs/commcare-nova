/** Actual author-input boundaries. Full emitted-schema generation is covered
 * by lookupAuthorBoundary; this suite makes no provider-specific
 * optional-count or native wire claim. */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { addCaseListColumnsTool } from "../addCaseListColumns";
import { addSearchInputsTool } from "../addSearchInputs";
import { configureCaseSelectionTool } from "../configureCaseSelection";
import { removeCaseListColumnTool } from "../removeCaseListColumn";
import { removeSearchInputTool } from "../removeSearchInput";
import { reorderCaseListColumnsTool } from "../reorderCaseListColumns";
import { reorderSearchInputsTool } from "../reorderSearchInputs";
import { setCaseListFilterTool } from "../setCaseListFilter";
import { setCaseListTileTool } from "../setCaseListTile";
import {
	caseTileLayoutInputSchema,
	columnInputSchema,
	columnUpdateInputSchema,
	stampColumnUuid,
	tileCellFromInput,
	tileCellInputSchema,
} from "../shared";
import { updateCaseListColumnTool } from "../updateCaseListColumn";
import { updateSearchInputTool } from "../updateSearchInput";

const MODULE_UUID = "11111111-1111-4111-8111-111111111111";

describe("case-list author command boundaries", () => {
	// ── Representative-payload smoke tests ────────────────────────────

	it("addCaseListColumns: parses a representative payload", () => {
		const result = addCaseListColumnsTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			columns: [
				{ kind: "plain", field: "case_name", header: "Patient" },
				{ kind: "phone", field: "phone", header: "Phone" },
			],
		});
		expect(result.success).toBe(true);
	});

	it("accepts a fully hidden saved definition with or without a sort role", () => {
		const dormant = addCaseListColumnsTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			columns: [
				{
					kind: "plain",
					field: "phone",
					header: "Phone",
					visibleInList: false,
					visibleInDetail: false,
				},
			],
		});
		const sortCarrier = addCaseListColumnsTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			columns: [
				{
					kind: "plain",
					field: "phone",
					header: "Phone",
					visibleInList: false,
					visibleInDetail: false,
					sort: { direction: "asc", priority: 0 },
				},
			],
		});

		expect(dormant.success).toBe(true);
		expect(sortCarrier.success).toBe(true);
	});

	it("updateCaseListColumn: parses a representative payload", () => {
		const result = updateCaseListColumnTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			columnUuid: "11111111-1111-4111-8111-111111111111",
			column: {
				kind: "date",
				field: "dob",
				header: "DOB",
				pattern: "%Y-%m-%d",
			},
		});
		expect(result.success).toBe(true);
	});

	it("updateCaseListColumn: accepts an interval column with explicit display and sort choices", () => {
		const result = updateCaseListColumnTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			columnUuid: "11111111-1111-4111-8111-111111111111",
			column: {
				kind: "interval",
				field: "last_visit",
				header: "Last visit",
				threshold: 30,
				unit: "days",
				display: "flag",
				text: "Overdue",
				sort: { direction: "desc", priority: 0 },
				visibleInList: true,
				visibleInDetail: false,
			},
		});
		expect(result.success).toBe(true);
	});

	it("column inputs reject obsolete member-level order keys", () => {
		for (const key of ["order", "listOrder", "detailOrder"] as const) {
			const result = updateCaseListColumnTool.inputSchema.safeParse({
				moduleUuid: MODULE_UUID,
				columnUuid: "11111111-1111-4111-8111-111111111111",
				column: {
					kind: "plain",
					field: "case_name",
					header: "Patient",
					[key]: "technical-key",
				},
			});
			expect(result.success, `${key} must stay off the SA surface`).toBe(false);
		}
	});

	it("takes a tile cell when a column is born, never when one is replaced", () => {
		// A column joining an already-tiled case list must be born placed or the
		// gate rejects the add for a field with nowhere to sit. A REPLACEMENT
		// keeps whatever placement the column already has (the `updateColumn`
		// reducer preserves the cell unconditionally), so a cell offered here
		// would be read and silently discarded — `setCaseListTile` moves fields.
		const column = {
			kind: "plain",
			field: "case_name",
			header: "Patient",
			tile: { x: 0, y: 0, width: 12, height: 1 },
		};
		const born = addCaseListColumnsTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			columns: [column],
		});
		const replaced = updateCaseListColumnTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			columnUuid: "11111111-1111-4111-8111-111111111111",
			column,
		});

		expect(born.success).toBe(true);
		expect(replaced.success).toBe(false);
	});

	it("setCaseListTile: parses a representative payload", () => {
		const result = setCaseListTileTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			tile: { persistOnForms: true },
			placements: [
				{
					columnUuid: "11111111-1111-4111-8111-111111111111",
					cell: {
						x: 0,
						y: 0,
						width: 12,
						height: 1,
						horizontalAlign: "center",
						verticalAlign: "middle",
						fontSize: "large",
						showBorder: true,
						showShading: true,
					},
				},
				{
					columnUuid: "22222222-2222-4222-8222-222222222222",
					cell: { x: 0, y: 1, width: 6, height: 1 },
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("configureCaseSelection: accepts only the bounded multiple arm or null", () => {
		for (const selection of [
			{ kind: "multiple", maximum: 1 },
			{ kind: "multiple", maximum: 100 },
			null,
		]) {
			expect(
				configureCaseSelectionTool.inputSchema.safeParse({
					moduleUuid: MODULE_UUID,
					selection,
				}).success,
			).toBe(true);
		}
		for (const selection of [
			{ kind: "single", maximum: 1 },
			{ kind: "multiple", maximum: 0 },
			{ kind: "multiple", maximum: 101 },
			{ kind: "multiple", maximum: 1.5 },
		]) {
			expect(
				configureCaseSelectionTool.inputSchema.safeParse({
					moduleUuid: MODULE_UUID,
					selection,
				}).success,
			).toBe(false);
		}
		expect(
			configureCaseSelectionTool.inputSchema.safeParse({
				moduleUuid: MODULE_UUID,
				selection: { kind: "multiple", maximum: 10 },
				confirmedModuleUuids: ["22222222-2222-4222-8222-222222222222"],
				confirmationToken: "a".repeat(64),
			}).success,
		).toBe(true);
		expect(
			configureCaseSelectionTool.inputSchema.safeParse({
				moduleUuid: MODULE_UUID,
				selection: { kind: "multiple", maximum: 10 },
				confirmedModuleUuids: ["22222222-2222-4222-8222-222222222222"],
			}).success,
		).toBe(false);
		expect(
			configureCaseSelectionTool.inputSchema.safeParse({
				moduleUuid: MODULE_UUID,
				selection: { kind: "multiple", maximum: 10 },
				confirmedModuleUuids: [],
			}).success,
		).toBe(false);
	});

	it("setCaseListTile: both clears are expressible", () => {
		// Turning the tile off and taking one field off it are different acts, and
		// each needs its own explicit null — a tool that could not distinguish
		// "leave this alone" from "clear this" could express neither.
		const layoutOff = setCaseListTileTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			tile: null,
		});
		const fieldUnplaced = setCaseListTileTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			placements: [
				{ columnUuid: "11111111-1111-4111-8111-111111111111", cell: null },
			],
		});
		const plainTile = setCaseListTileTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			tile: {},
		});

		expect(layoutOff.success).toBe(true);
		expect(fieldUnplaced.success).toBe(true);
		expect(plainTile.success).toBe(true);
	});

	it("setCaseListTile: a placement always decides where the field goes", () => {
		// `cell` is required-and-nullable, so "named but unstated" — the shape a
		// caller reaches for when it means "leave this one alone" — is rejected
		// rather than read as a clear. Leaving the field out is how you keep it.
		const result = setCaseListTileTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			placements: [{ columnUuid: "11111111-1111-4111-8111-111111111111" }],
		});
		expect(result.success).toBe(false);
	});

	it("removeCaseListColumn: parses a representative payload", () => {
		const result = removeCaseListColumnTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			columnUuid: "11111111-1111-4111-8111-111111111111",
		});
		expect(result.success).toBe(true);
	});

	it("reorderCaseListColumns: parses a representative payload", () => {
		const result = reorderCaseListColumnsTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			surface: "results",
			columnUuids: [
				"22222222-2222-4222-8222-222222222222",
				"11111111-1111-4111-8111-111111111111",
			],
		});
		expect(result.success).toBe(true);
	});

	it("setCaseListFilter: parses a representative payload (predicate set)", () => {
		const result = setCaseListFilterTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			filter: {
				kind: "eq",
				left: {
					kind: "term",
					term: { kind: "prop", caseType: "patient", property: "status" },
				},
				right: { kind: "term", term: { kind: "literal", value: "active" } },
			},
		});
		expect(result.success).toBe(true);
	});

	it("setCaseListFilter: parses null (clear)", () => {
		const result = setCaseListFilterTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			filter: null,
		});
		expect(result.success).toBe(true);
	});

	it("addSearchInputs: parses a representative simple payload", () => {
		const result = addSearchInputsTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			searchInputs: [
				{
					kind: "simple",
					name: "patient_name_input",
					label: "Patient name",
					type: "text",
					property: "full_name",
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it("addSearchInputs: parses a representative advanced payload", () => {
		const result = addSearchInputsTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			searchInputs: [
				{
					kind: "advanced",
					name: "active_only",
					label: "Active only",
					type: "text",
					predicate: { kind: "match-all" },
				},
			],
		});
		expect(result.success).toBe(true);
	});

	it.each(["select", "multi-select"])(
		"requires lookup options for %s inputs on both authored arms",
		(type) => {
			const options = {
				kind: "lookup",
				tableId: "018f3e8a-7b2c-7def-8abc-1234567890ab",
				valueColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ad",
				labelColumnId: "018f3e8a-7b2c-7def-8abc-1234567890ae",
			};
			for (const arm of [
				{ kind: "simple", property: "referral_status" },
				{ kind: "advanced", predicate: { kind: "match-all" } },
			]) {
				const body = { ...arm, name: "status", label: "Status", type };
				expect(
					addSearchInputsTool.inputSchema.safeParse({
						moduleUuid: MODULE_UUID,
						searchInputs: [body],
					}).success,
				).toBe(false);
				expect(
					addSearchInputsTool.inputSchema.safeParse({
						moduleUuid: MODULE_UUID,
						searchInputs: [{ ...body, options }],
					}).success,
				).toBe(true);
				expect(
					updateSearchInputTool.inputSchema.safeParse({
						moduleUuid: MODULE_UUID,
						searchInputUuid: "22222222-2222-4222-8222-222222222222",
						searchInput: { ...body, options },
					}).success,
				).toBe(true);
			}
		},
	);

	it("requires the exact date-range arm at the tool boundary", () => {
		const base = {
			moduleUuid: MODULE_UUID,
			searchInputUuid: "11111111-1111-4111-8111-111111111111",
		};
		const scalarDefault = updateSearchInputTool.inputSchema.safeParse({
			...base,
			searchInput: {
				kind: "simple",
				name: "visit_window",
				label: "Visit window",
				type: "date-range",
				property: "visit_date",
				mode: { kind: "range" },
				default: { kind: "today" },
			},
		});
		const missingMode = updateSearchInputTool.inputSchema.safeParse({
			...base,
			searchInput: {
				kind: "simple",
				name: "visit_window",
				label: "Visit window",
				type: "date-range",
				property: "visit_date",
			},
		});
		const wrongWidget = updateSearchInputTool.inputSchema.safeParse({
			...base,
			searchInput: {
				kind: "simple",
				name: "visit_window",
				label: "Visit window",
				type: "date",
				property: "visit_date",
				mode: { kind: "range" },
			},
		});
		const validRange = updateSearchInputTool.inputSchema.safeParse({
			...base,
			searchInput: {
				kind: "simple",
				name: "visit_window",
				label: "Visit window",
				type: "date-range",
				property: "visit_date",
				mode: { kind: "range" },
			},
		});

		expect(scalarDefault.success).toBe(false);
		expect(missingMode.success).toBe(false);
		expect(wrongWidget.success).toBe(false);
		expect(validRange.success).toBe(true);
	});

	it("updateSearchInput: accepts an ancestor-targeted simple input with a starting value", () => {
		const result = updateSearchInputTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			searchInputUuid: "11111111-1111-4111-8111-111111111111",
			searchInput: {
				kind: "simple",
				name: "household_region",
				label: "Region",
				type: "text",
				property: "region",
				via: {
					kind: "ancestor",
					via: [{ identifier: "parent", throughCaseType: "household" }],
				},
				mode: { kind: "exact" },
				default: { kind: "term", term: { kind: "literal", value: "north" } },
			},
		});
		expect(result.success).toBe(true);
	});

	it("removeSearchInput: parses a representative payload", () => {
		const result = removeSearchInputTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			searchInputUuid: "11111111-1111-4111-8111-111111111111",
		});
		expect(result.success).toBe(true);
	});

	it("reorderSearchInputs: parses a representative payload", () => {
		const result = reorderSearchInputsTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			searchInputUuids: [
				"22222222-2222-4222-8222-222222222222",
				"11111111-1111-4111-8111-111111111111",
			],
		});
		expect(result.success).toBe(true);
	});
});

/** Each arm's own `sort` text, keyed by the column kind. */
const SORT_DESCRIPTIONS = {
	plain:
		"This column's order rule. A plain column orders by the saved value, as a number for a number property and as text otherwise; shown on Results over a choice property with options, by the option label it shows.",
	date: "This column's order rule. A date column orders by the saved date, whatever pattern shows it.",
	phone: "This column's order rule. A phone column orders by the saved value.",
	"id-mapping":
		"This column's order rule. Shown on Results, an ID mapping orders by the order of its mapping entries, never by label: cases holding the first entry's value come first when ascending, and a value with no entry counts as no value.",
	"image-map":
		"This column's order rule. Shown on Results, an image map orders by the order of its mapping entries: cases holding the first entry's value come first when ascending, and a value with no entry counts as no value.",
	interval:
		"This column's order rule. Shown on Results, an interval column orders by the text it shows, compared as text, so 10 comes before 2.",
	link: "This column's order rule. A link column orders by the saved value, never by its link text.",
	calculated:
		"This column's order rule. A calculated column orders by its result, as a number where the expression gives a number and as text otherwise.",
} as const;

const VISIBLE_IN_LIST =
	"Leave it out to show the column on Results; false hides it there. The list's search still matches a hidden column. In a list with a case tile a hidden column is not on the tile, and the search matches it only where it carries sort.";

describe("case-list tool descriptions", () => {
	it("give every column arm its own sort text and the visibleInList text, on add and on replace", () => {
		for (const schema of [columnInputSchema, columnUpdateInputSchema]) {
			const kinds = schema.options.map((arm) => arm.shape.kind.value);
			expect(kinds.sort()).toEqual(Object.keys(SORT_DESCRIPTIONS).sort());
			for (const arm of schema.options) {
				const kind = arm.shape.kind.value;
				expect(arm.shape.sort.description, kind).toBe(SORT_DESCRIPTIONS[kind]);
				expect(arm.shape.visibleInList.description, kind).toBe(VISIBLE_IN_LIST);
			}
		}
	});

	it("say what a date pattern and each mapping table may hold", () => {
		for (const schema of [columnInputSchema, columnUpdateInputSchema]) {
			const arm = <K extends string>(kind: K) =>
				schema.options.find((option) => option.shape.kind.value === kind);
			const date = arm("date");
			const idMapping = arm("id-mapping");
			const imageMap = arm("image-map");
			if (
				date === undefined ||
				!("pattern" in date.shape) ||
				idMapping === undefined ||
				!("mapping" in idMapping.shape) ||
				imageMap === undefined ||
				!("mapping" in imageMap.shape)
			) {
				throw new Error("the column union lost an arm");
			}
			expect(date.shape.pattern.description).toBe(
				"How the date is shown, as a CommCare date pattern such as %Y-%m-%d or %B %e, %Y. It can't hold a straight apostrophe ('); a curved one (’) works.",
			);
			expect(idMapping.shape.mapping.description).toBe(
				"The value-to-label table, one entry for each saved value. A value is one word with no spaces and can't hold &, <, >, \" or '. Entry order matters: it is the order the list sorts this column by.",
			);
			expect(imageMap.shape.mapping.description).toBe(
				"The value-to-image table, one entry for each saved value. A value is one word with no spaces. Entry order matters: it is the order the list sorts this column by.",
			);
		}
	});

	it("keep the mapping's own refusal of a repeated value under its description", () => {
		const result = addCaseListColumnsTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			columns: [
				{
					kind: "id-mapping",
					field: "zone",
					header: "Zone",
					mapping: [
						{ value: "n", label: "North" },
						{ value: "n", label: "Also north" },
					],
				},
			],
		});
		expect(result.success).toBe(false);
	});

	it("state each tile cell slot's values and the one it takes when left out", () => {
		expect(tileCellInputSchema.shape.horizontalAlign.description).toBe(
			"Where the content sits across the field's own rectangle: left, center or right. Leave it out for left.",
		);
		expect(tileCellInputSchema.shape.verticalAlign.description).toBe(
			"Where the content sits down the field's own rectangle: top, middle or bottom. Leave it out for top.",
		);
		expect(tileCellInputSchema.shape.fontSize.description).toBe(
			"Text size for this field: small, medium or large. Leave it out for medium. A tile's text has its own three sizes and never follows the rest of the list, so set small or large only where a field should recede or stand out.",
		);
	});

	it("tell the model that grouped tiles keep an unfinished form from reopening on Android", () => {
		const grouping = caseTileLayoutInputSchema.shape.grouping.description;
		expect(grouping).toContain(
			"Three consequences worth telling the user about",
		);
		expect(grouping).toContain("can't be opened again");
	});
});

describe("tile cells an input leaves unstyled", () => {
	it("parse a placement and a born-placed column with the three slots left out", () => {
		const placement = setCaseListTileTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			placements: [
				{
					columnUuid: "11111111-1111-4111-8111-111111111111",
					cell: { x: 0, y: 0, width: 12, height: 1 },
				},
			],
		});
		const born = addCaseListColumnsTool.inputSchema.safeParse({
			moduleUuid: MODULE_UUID,
			columns: [
				{
					kind: "plain",
					field: "case_name",
					header: "Patient",
					tile: { x: 0, y: 0, width: 12, height: 1 },
				},
			],
		});
		expect(placement.success).toBe(true);
		expect(born.success).toBe(true);
	});

	it("fill left, top and medium where the input states none, and keep what it states", () => {
		expect(tileCellFromInput({ x: 0, y: 1, width: 6, height: 2 })).toEqual({
			x: 0,
			y: 1,
			width: 6,
			height: 2,
			horizontalAlign: "left",
			verticalAlign: "top",
			fontSize: "medium",
		});
		expect(
			tileCellFromInput({
				x: 0,
				y: 0,
				width: 12,
				height: 1,
				fontSize: "large",
				showBorder: true,
			}),
		).toEqual({
			x: 0,
			y: 0,
			width: 12,
			height: 1,
			horizontalAlign: "left",
			verticalAlign: "top",
			fontSize: "large",
			showBorder: true,
		});
	});

	it("give a born-placed column the filled cell when its uuid is stamped", () => {
		const column = stampColumnUuid(
			{
				kind: "plain",
				field: "case_name",
				header: "Patient",
				tile: { x: 0, y: 0, width: 12, height: 1, horizontalAlign: "right" },
			},
			testUuid("33333333-3333-4333-8333-333333333333"),
		);
		expect(column.tile).toEqual({
			x: 0,
			y: 0,
			width: 12,
			height: 1,
			horizontalAlign: "right",
			verticalAlign: "top",
			fontSize: "medium",
		});
	});
});
