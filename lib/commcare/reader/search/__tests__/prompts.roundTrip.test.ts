/**
 * Contract: each Search field Nova emits reads back into its slots, and the prompts HQ's pages
 * write that Nova cannot write back raise their entries. The failure it catches: a prompt key read
 * into the wrong slot; a required message stored where it is the default; a simple field read as
 * advanced; a prompt Nova cannot write back read as held.
 */
import { describe, expect, it } from "vitest";
import type { SearchInputDef } from "@/lib/domain";
import { plainColumn } from "@/lib/domain/modules";
import { patients, uuid } from "../../caseList/__tests__/fixtures";
import {
	codes,
	comparableList,
	listOf,
	readLists,
} from "../../caseList/__tests__/listReading";

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
