// components/builder/case-list-config/__tests__/columnEditorSchemas.test.ts
//
// Registry-shape tests for the column card editor. Two
// invariants pinned here (mirrors `editorSchemas.test.ts` /
// `expressionEditorSchemas.test.ts`):
//
//   1. Exhaustivity over the ColumnKind union — every kind
//      appears as a key in `columnCardSchemas`. The mapped-type
//      `Record<ColumnKind, ...>` enforces this at the type
//      layer; the runtime guard verifies the keys at the
//      import boundary as a defense against an `as` cast
//      bypassing the type system.
//
//   2. Every entry's `defaultValue(ctx)` factory produces a kind-
//      valid AST. The schema's parse pass is the structural
//      contract.

import { describe, expect, it } from "vitest";
import { type CaseType, type Column, columnSchema } from "@/lib/domain";
import {
	type ColumnEditContext,
	columnCardSchemas,
	resolveColumnPropertyDataType,
} from "../columnEditorSchemas";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "dob", label: "Date of birth", data_type: "date" },
	],
};

const ctx: ColumnEditContext = {
	caseTypes: [PATIENT],
	currentCaseType: "patient",
};

describe("columnCardSchemas — registry exhaustivity", () => {
	it("declares an entry for every ColumnKind", () => {
		const expected: ReadonlySet<Column["kind"]> = new Set([
			"plain",
			"date",
			"phone",
			"id-mapping",
			"image-map",
			"interval",
			"calculated",
		]);
		const actual = new Set(Object.keys(columnCardSchemas));
		expect(actual).toEqual(expected);
	});
});

describe("columnCardSchemas — defaultValue parses through schema", () => {
	for (const kind of Object.keys(columnCardSchemas) as Column["kind"][]) {
		it(`${kind}: default parses`, () => {
			const value = columnCardSchemas[kind].defaultValue(ctx);
			expect(() => columnSchema.parse(value)).not.toThrow();
		});
	}

	it("seeds canonical names from a legacy alias catalog", () => {
		const legacyCtx: ColumnEditContext = {
			currentCaseType: "patient",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "name", label: "Patient", data_type: "text" },
						{
							name: "date-opened",
							label: "Opened",
							data_type: "datetime",
						},
						{ name: "case_name", label: "Case name", data_type: "text" },
						{
							name: "date_opened",
							label: "Date opened",
							data_type: "datetime",
						},
					],
				},
			],
		};

		const plain = columnCardSchemas.plain.defaultValue(legacyCtx);
		const date = columnCardSchemas.date.defaultValue(legacyCtx);
		expect(plain.kind === "plain" ? plain.field : "").toBe("case_name");
		expect(date.kind === "date" ? date.field : "").toBe("date_opened");
		expect(resolveColumnPropertyDataType(legacyCtx, "date-opened")).toBe(
			"datetime",
		);
	});
});

describe("columnCardSchemas — applicableForProperty", () => {
	const dateProp = PATIENT.properties[1];
	const textProp = PATIENT.properties[0];
	const noProperty = undefined;

	it("Plain accepts every property type and an unset field", () => {
		const schema = columnCardSchemas.plain;
		expect(schema.applicableForProperty(dateProp)).toBe(true);
		expect(schema.applicableForProperty(textProp)).toBe(true);
		expect(schema.applicableForProperty(noProperty)).toBe(true);
	});

	it("Date / Interval require date properties", () => {
		const dateKinds = ["date", "interval"] as const;
		for (const k of dateKinds) {
			const schema = columnCardSchemas[k];
			expect(schema.applicableForProperty(dateProp)).toBe(true);
			expect(schema.applicableForProperty(textProp)).toBe(false);
			// Unset / unresolved property — applicability stays
			// permissive so the kind picker isn't locked out while
			// the user is choosing a property.
			expect(schema.applicableForProperty(noProperty)).toBe(true);
		}
	});

	it("Phone requires a text-shaped property", () => {
		const schema = columnCardSchemas.phone;
		expect(schema.applicableForProperty(textProp)).toBe(true);
		expect(schema.applicableForProperty(dateProp)).toBe(false);
		expect(schema.applicableForProperty(noProperty)).toBe(true);
	});

	it("ID Mapping accepts any property", () => {
		const schema = columnCardSchemas["id-mapping"];
		expect(schema.applicableForProperty(dateProp)).toBe(true);
		expect(schema.applicableForProperty(textProp)).toBe(true);
		expect(schema.applicableForProperty(noProperty)).toBe(true);
	});

	it("Calculated accepts any property — calc has no field, the predicate is permissive", () => {
		const schema = columnCardSchemas.calculated;
		expect(schema.applicableForProperty(dateProp)).toBe(true);
		expect(schema.applicableForProperty(textProp)).toBe(true);
		expect(schema.applicableForProperty(noProperty)).toBe(true);
	});
});
