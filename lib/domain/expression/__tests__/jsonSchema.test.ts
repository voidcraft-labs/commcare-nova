// Execute generated schemas with AJV, the case-store's validator. This proves
// admission of JSON-representable values, not Postgres constraints or full HQ
// geopoint compatibility. Nonfinite JavaScript numbers belong to the store
// boundary tests because they change to null during JSON serialization.
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
	type CasePropertyDataType,
	type CaseType,
	caseTypeSchema,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { caseTypeToJsonSchema } from "../jsonSchema";

function validator(caseType: CaseType) {
	const admitted = caseTypeSchema.parse(caseType);
	const ajv = new Ajv2020({ strict: false });
	addFormats(ajv);
	return ajv.compile(caseTypeToJsonSchema(admitted));
}

const shapes: Array<{
	kind: CasePropertyDataType | undefined;
	valid: unknown[];
	invalid: unknown[];
}> = [
	{ kind: undefined, valid: ["", "note"], invalid: [1, null] },
	{ kind: "text", valid: ["", "note"], invalid: [true, [], {}] },
	{
		kind: "int",
		valid: [-2147483648, 0, 2147483647],
		invalid: [-2147483649, 2147483648, 1.5, "1"],
	},
	{ kind: "decimal", valid: [-1.5, 0, 3], invalid: ["3.2", null, []] },
	{
		kind: "date",
		valid: ["2024-02-29"],
		invalid: ["2023-02-29", "2024-13-01", "not-a-date"],
	},
	{
		kind: "time",
		valid: ["12:30:00Z", "12:30:00+02:00"],
		invalid: ["25:30:00Z", "12:30"],
	},
	{
		kind: "datetime",
		valid: ["2024-02-29T12:30:00Z"],
		invalid: ["2023-02-29T12:30:00Z", "2024-02-29"],
	},
	{
		kind: "single_select",
		valid: ["retired-option", ""],
		invalid: [["current"], 1],
	},
	{
		kind: "multi_select",
		valid: [["retired-option", "current"], []],
		invalid: ["current", [1], null],
	},
];

describe("case property JSON schema admission", () => {
	it.each(shapes)(
		"validates $kind through AJV without coercion",
		({ kind, valid, invalid }) => {
			const validate = validator({
				name: "patient",
				properties: [
					{
						name: "answer",
						label: proseText("Answer"),
						...(kind ? { data_type: kind } : {}),
					},
				],
			});
			expect(validate({})).toBe(true); // newly declared properties can be absent from existing rows
			for (const value of valid)
				expect(validate({ answer: value }), JSON.stringify(value)).toBe(true);
			for (const value of invalid)
				expect(validate({ answer: value }), String(value)).toBe(false);
			expect(validate({ unknown: "value" })).toBe(false);
		},
	);

	it.each(["single_select", "multi_select"] as const)(
		"keeps historical %s values valid after choices change",
		(kind) => {
			const property = {
				name: "answer",
				label: proseText("Answer"),
				data_type: kind,
			};
			const historical = { answer: kind === "single_select" ? "old" : ["old"] };
			for (const options of [
				undefined,
				[],
				[{ value: "new", label: proseText("New") }],
			]) {
				expect(
					validator({
						name: "patient",
						properties: [{ ...property, ...(options ? { options } : {}) }],
					})(historical),
				).toBe(true);
			}
			if (kind === "single_select")
				expect(
					caseTypeToJsonSchema({ name: "patient", properties: [property] })
						.properties.answer,
				).toMatchObject({ "x-novaDataType": "single_select" });
		},
	);

	it("excludes scalar columns from the JSON property bag", () => {
		const names = [
			"case_id",
			"case_type",
			"case_name",
			"date_opened",
			"last_modified",
			"owner_id",
			"external_id",
			"status",
		];
		const ct = caseTypeSchema.parse({
			name: "patient",
			properties: [...names, "notes"].map((name) => ({
				name,
				label: proseText(name),
			})),
		});
		const validate = validator(ct);
		expect(validate({ notes: "a note" })).toBe(true);
		for (const name of names)
			expect(validate({ [name]: "scalar" }), name).toBe(false);
	});

	it("admits the empty property bag but refuses arbitrary keys", () => {
		const validate = validator({ name: "patient", properties: [] });
		expect(validate({})).toBe(true);
		expect(validate({ unknown: "value" })).toBe(false);
	});

	it("checks Nova's four-number geopoint storage grammar", () => {
		const validate = validator({
			name: "clinic",
			properties: [
				{
					name: "location",
					label: proseText("Location"),
					data_type: "geopoint",
				},
			],
		});
		// First examples appear in couchforms/tests/test_geopoint.py. This corpus
		// does not assert full Decimal syntax or geographical range validation.
		for (const location of [
			"42.3739063 -71.1109113 0.0 886.0",
			"-7.130 -41.563 7.53E-4 8.0",
			"-7.130 -41.563 -2.2709742188453674E-4 8.0",
			"1.23e-5 2.0e10 0 0",
		])
			expect(validate({ location }), location).toBe(true);
		for (const location of [
			"these are not decimals",
			"42 -71 0 whoops",
			"42 -71 0",
			"-7 -41",
			"14 -17 0 0 0",
			"14,-17,0,0",
			"14\t-17 0 0",
			"",
			"+1 -17 0 0",
			".5 -17 0 0",
			"5. -17 0 0",
			"NaN -71 0 0",
		])
			expect(validate({ location }), location).toBe(false);
	});
});
