/**
 * Contract: each Search field Nova emits reads back into its slots, and the prompts HQ's pages
 * write that Nova cannot write back raise their entries. The failure it catches: a prompt key read
 * into the wrong slot; a required message stored where it is the default; a simple field read as
 * advanced; a prompt Nova cannot write back read as held.
 */
import { describe, expect, it } from "vitest";
import type { BlueprintDoc, SearchInputDef } from "@/lib/domain";
import {
	eq,
	input,
	literal,
	matchAll,
	neq,
	or,
	prop,
	tableColumn,
	term,
	whenInput,
} from "@/lib/domain/expression/builders";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { plainColumn } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import { lookupWireNaming } from "../../../lookup/naming";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import {
	codes,
	comparableList,
	listOf,
	readLists,
} from "../../caseList/__tests__/listReading";
import type { ReaderInput } from "../../types";

async function roundTrip(inputs: SearchInputDef[]) {
	const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
		searchInputs: inputs,
		search: {},
	});
	const reading = await readLists(doc);
	return {
		reading,
		read: comparableList(listOf(reading)) as { searchInputs: unknown[] },
	};
}

/** The authored fields without their uuids, each Search field read named by the uuid the
 *  reading minted for the field at its place. */
function asRead(
	inputs: readonly SearchInputDef[],
	reading: Awaited<ReturnType<typeof readLists>>,
): unknown[] {
	const minted = listOf(reading).searchInputs.map((one) => one.uuid);
	let text = JSON.stringify(inputs.map(({ uuid: _uuid, ...rest }) => rest));
	inputs.forEach((one, index) => {
		const read = minted[index];
		if (read !== undefined) text = text.split(one.uuid).join(read);
	});
	return JSON.parse(text) as unknown[];
}

describe("Search fields Nova emits", () => {
	it("reads a text field with a hint and a required message", async () => {
		const input: SearchInputDef = {
			uuid: uuid(9),
			name: "notes",
			label: "Notes",
			hint: "Part of the notes",
			required: { message: "Say something" },
			kind: "simple",
			type: "text",
			property: "notes",
		};
		const { reading, read } = await roundTrip([input]);
		expect(codes(reading)).toEqual([]);
		const { uuid: _uuid, ...rest } = input;
		expect(read.searchInputs).toEqual([rest]);
	});

	it("reads a required field with Nova's default message as an absent message", async () => {
		const input: SearchInputDef = {
			uuid: uuid(9),
			name: "notes",
			label: "Notes",
			required: {},
			kind: "simple",
			type: "text",
			property: "notes",
		};
		const { reading, read } = await roundTrip([input]);
		expect(codes(reading)).toEqual([]);
		expect(read.searchInputs).toEqual([
			{
				name: "notes",
				label: "Notes",
				required: {},
				kind: "simple",
				type: "text",
				property: "notes",
			},
		]);
	});

	it("reads a barcode field and a date range field", async () => {
		const inputs: SearchInputDef[] = [
			{
				uuid: uuid(9),
				name: "phone",
				label: "Phone",
				kind: "simple",
				type: "barcode",
				property: "phone",
			},
			{
				uuid: uuid(10),
				name: "dob",
				label: "Born",
				kind: "simple",
				type: "date-range",
				property: "dob",
				mode: { kind: "range" },
			},
		];
		const { reading, read } = await roundTrip(inputs);
		expect(codes(reading)).toEqual([]);
		expect(read.searchInputs).toEqual(
			inputs.map(({ uuid: _uuid, ...rest }) => rest),
		);
	});
});

describe("each Search field's slots and arm", () => {
	const text = (extra: Partial<SearchInputDef>): SearchInputDef =>
		({
			uuid: uuid(9),
			name: "notes",
			label: "Notes",
			kind: "simple",
			type: "text",
			property: "notes",
			...extra,
		}) as SearchInputDef;

	const cases: [string, SearchInputDef[]][] = [
		[
			"a field with a starting value",
			[text({ default: term(literal("well")) })],
		],
		[
			"a field with a validation rule",
			[
				text({
					validation: {
						rule: neq(input(uuid(9)), literal("none")),
						message: "Say more",
					},
				}),
			],
		],
		[
			"a hidden value beside a visible field",
			[
				text({}),
				{
					uuid: uuid(10),
					kind: "hidden",
					name: "region",
					label: "Region",
					value: term(literal("north")),
				},
			],
		],
		[
			"a field over the owner, written excluded with its own row",
			[text({ name: "owner_id", label: "Owner", property: "owner_id" })],
		],
		[
			"a field whose condition reads two properties",
			[
				{
					uuid: uuid(9),
					name: "anything",
					label: "Anything",
					kind: "advanced",
					type: "text",
					predicate: whenInput(
						input(uuid(9)),
						or(
							eq(prop("patient", "notes"), input(uuid(9))),
							eq(prop("patient", "phone"), input(uuid(9))),
						),
					),
				},
			],
		],
		[
			"a field no filter reads",
			[
				{
					uuid: uuid(9),
					name: "anything",
					label: "Anything",
					kind: "advanced",
					type: "text",
					predicate: matchAll(),
				},
			],
		],
	];
	for (const [name, inputs] of cases)
		it(`reads ${name}`, async () => {
			const { reading, read } = await roundTrip(inputs);
			expect(codes(reading)).toEqual([]);
			expect(read.searchInputs).toEqual(asRead(inputs, reading));
		});

	it("raises a date range field over a property a text question saves", async () => {
		const { reading } = await roundTrip([
			{
				uuid: uuid(9),
				name: "notes",
				label: "Notes",
				kind: "simple",
				type: "date-range",
				property: "notes",
				mode: { kind: "range" },
			},
		]);
		const finding = reading.findings.find(
			(one) =>
				one.code === "case-search/search-field-over-a-property-of-another-type",
		);
		expect(finding?.detail.name).toBe("notes");
	});

	it("declares a date range field's property `date` where no question types it", async () => {
		const { reading } = await roundTrip([
			{
				uuid: uuid(9),
				name: "due",
				label: "Due",
				kind: "simple",
				type: "date-range",
				property: "due",
				mode: { kind: "range" },
			},
		]);
		expect(codes(reading)).toEqual([]);
		const due = reading.ctx.doc?.caseTypes
			?.find((type) => type.name === "patient")
			?.properties.find((property) => property.name === "due");
		expect(due?.data_type).toBe("date");
	});
});

describe("prompts HQ's pages write that Nova does not", () => {
	async function edited(change: Record<string, unknown>) {
		const input: SearchInputDef = {
			uuid: uuid(9),
			name: "notes",
			label: "Notes",
			kind: "simple",
			type: "text",
			property: "notes",
		};
		return readLists(
			patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: [input],
				search: {},
			}),
			{
				edit: (app) => {
					const properties = app.modules[0]?.search_config.properties as Record<
						string,
						unknown
					>[];
					if (properties[0] !== undefined) Object.assign(properties[0], change);
				},
				firstPassOnly: true,
			},
		);
	}

	for (const name of ["owner_id", "case_id", "status"])
		it(`raises a bare prompt named ${name}`, async () => {
			const reading = await edited({ name });
			expect(codes(reading)).toContain(
				"case-search/prompt-named-for-a-case-attribute-hq-matches-itself",
			);
		});

	it("raises a bare date prompt", async () => {
		const reading = await edited({ input_: "date" });
		expect(codes(reading)).toContain(
			"case-search/date-prompt-matched-by-hq-s-own-rule",
		);
	});

	it("raises a second validation", async () => {
		const reading = await edited({
			validations: [
				{ test: "true()", text: { en: "a" } },
				{ test: "true()", text: { en: "b" } },
			],
		});
		expect(codes(reading)).toContain("case-search/validations-1");
	});
});

describe("Search fields over a table and over dates", () => {
	const TABLE = "01890000-0000-7000-8000-000000000301" as LookupTableId;
	const CODE = "01890000-0000-7000-8000-000000000302" as LookupColumnId;
	const NAME = "01890000-0000-7000-8000-000000000303" as LookupColumnId;
	const REGION = "01890000-0000-7000-8000-000000000304" as LookupColumnId;
	const RANK = "01890000-0000-7000-8000-000000000305" as LookupColumnId;
	const columns = [
		{ id: CODE, wireName: "code", label: "Code", dataType: "text" as const },
		{ id: NAME, wireName: "name", label: "Name", dataType: "text" as const },
		{
			id: REGION,
			wireName: "region",
			label: "Region",
			dataType: "text" as const,
		},
		{ id: RANK, wireName: "rank", label: "Rank", dataType: "int" as const },
	];
	const naming = lookupWireNaming([{ id: TABLE, tag: "districts", columns }]);
	/** The project space's table of districts, as a reading is given it. */
	const withTable = (input: ReaderInput): ReaderInput => ({
		...input,
		lookup: {
			table: (tag) =>
				tag === "districts"
					? {
							tableId: TABLE,
							column: (name) =>
								columns.find((column) => column.wireName === name)?.id,
						}
					: undefined,
			definitions: new Map([
				[TABLE, { id: TABLE, name: "Districts", tag: "districts", columns }],
			]),
		},
	});

	for (const type of ["select", "multi-select"] as const)
		it(`reads a ${type} field whose choices come from a table, sorted and filtered`, async () => {
			const inputs: SearchInputDef[] = [
				{
					uuid: uuid(9),
					// A multiple-choice field matches the property it is named after.
					name: "notes",
					label: "District",
					kind: "simple",
					type,
					property: "notes",
					options: {
						kind: "lookup",
						tableId: TABLE,
						valueColumnId: CODE,
						labelColumnId: NAME,
						sortColumnId: RANK,
						filter: eq(term(tableColumn(TABLE, REGION)), literal("north")),
					},
				},
			];
			const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: inputs,
				search: {},
			});
			const reading = await readLists(doc, {
				lookupNaming: naming,
				input: withTable,
			});
			expect(codes(reading)).toEqual([]);
			const read = comparableList(listOf(reading)) as {
				searchInputs: unknown[];
			};
			expect(read.searchInputs).toEqual(asRead(inputs, reading));
			// The choices' filter is registered under its own slot.
			expect(reading.ctx.pending.list().map((one) => one.ref.slot)).toContain(
				"search_input_options",
			);
		});

	for (const dataType of ["date", "datetime"] as const)
		it(`reads a date field over a property only the catalog types ${dataType}`, async () => {
			const inputs: SearchInputDef[] = [
				{
					uuid: uuid(9),
					name: "due",
					label: "Due",
					kind: "simple",
					type: "date",
					property: "due",
				},
			];
			const doc = patients([plainColumn(uuid(1), "case_name", "Name")], {
				searchInputs: inputs,
				search: {},
			});
			const typed: BlueprintDoc = {
				...doc,
				caseTypes: [
					{
						name: "patient",
						properties: [
							{
								name: "due",
								label: proseText("Due"),
								data_type: dataType,
							},
						],
					},
				],
			};
			const reading = await readLists(typed);
			expect(codes(reading)).toEqual([]);
			const read = comparableList(listOf(reading)) as {
				searchInputs: unknown[];
			};
			expect(read.searchInputs).toEqual(asRead(inputs, reading));
		});
});
