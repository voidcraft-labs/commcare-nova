import { describe, expect, it } from "vitest";
import { type CaseType, type Column, columnSchema } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	type ColumnEditContext,
	canSeedColumnKind,
	columnCardSchemas,
	resolveColumnPropertyDataType,
} from "../columnEditorSchemas";
import { admittedWorkspace, commitWorkspace } from "./admittedWorkspace";

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "case_name", label: proseText("Name"), data_type: "text" },
		{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
	],
};

const ctx: ColumnEditContext = {
	caseTypes: [PATIENT],
	currentCaseType: "patient",
};

describe("columnCardSchemas — defaultValue parses through schema", () => {
	for (const kind of Object.keys(columnCardSchemas) as Column["kind"][]) {
		it(`${kind}: the factory supplies an admitted display definition`, () => {
			const value = columnCardSchemas[kind].defaultValue(ctx);
			expect(value).toBeDefined();
			if (value === undefined) throw new Error(`expected ${kind} seed`);
			expect(() => columnSchema.parse(value)).not.toThrow();
			const { doc, moduleUuid } = admittedWorkspace([...ctx.caseTypes]);
			expect(
				commitWorkspace(doc, [
					{
						kind: "addColumn",
						moduleUuid,
						column: value,
						afterInList: null,
						afterInDetail: null,
					},
				]).modules[moduleUuid].caseListConfig?.columns,
			).toContainEqual(value);
		});
	}

	it("returns unavailable instead of an unbound field-bearing default", () => {
		const emptyCtx: ColumnEditContext = {
			currentCaseType: "patient",
			caseTypes: [{ name: "patient", properties: [] }],
		};

		for (const kind of [
			"plain",
			"date",
			"phone",
			"link",
			"id-mapping",
			"image-map",
			"interval",
		] as const) {
			expect(columnCardSchemas[kind].defaultValue(emptyCtx)).toBeUndefined();
			expect(canSeedColumnKind(emptyCtx, kind)).toBe(false);
		}
		expect(columnCardSchemas.calculated.defaultValue(emptyCtx)).toBeDefined();
		expect(canSeedColumnKind(emptyCtx, "calculated")).toBe(true);
	});

	it("seeds exact standard names from the catalog", () => {
		const standardCtx: ColumnEditContext = {
			currentCaseType: "patient",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "case_name",
							label: proseText("Case name"),
							data_type: "text",
						},
						{
							name: "date_opened",
							label: proseText("Date opened"),
							data_type: "datetime",
						},
					],
				},
			],
		};

		const plain = columnCardSchemas.plain.defaultValue(standardCtx);
		const date = columnCardSchemas.date.defaultValue(standardCtx);
		expect(plain).toBeDefined();
		expect(date).toBeDefined();
		if (plain === undefined || date === undefined) {
			throw new Error("expected standard property seeds");
		}
		expect(plain.kind === "plain" ? plain.field : "").toBe("case_name");
		expect(date.kind === "date" ? date.field : "").toBe("date_opened");
		expect(resolveColumnPropertyDataType(standardCtx, "date_opened")).toBe(
			"datetime",
		);
	});

	it("seeds required display kinds from an honest unknown property", () => {
		const unknownCtx: ColumnEditContext = {
			currentCaseType: "patient",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "untyped_value",
							label: proseText("Imported value"),
						},
					],
				},
			],
		};

		for (const kind of ["date", "phone", "interval"] as const) {
			const value = columnCardSchemas[kind].defaultValue(unknownCtx);
			expect(value).toBeDefined();
			expect(canSeedColumnKind(unknownCtx, kind)).toBe(true);
			if (value === undefined) throw new Error(`expected ${kind} seed`);
			expect(value.field).toBe("untyped_value");
			expect(() => columnSchema.parse(value)).not.toThrow();
			const { doc, moduleUuid } = admittedWorkspace([...unknownCtx.caseTypes]);
			expect(
				commitWorkspace(doc, [
					{
						kind: "addColumn",
						moduleUuid,
						column: value,
						afterInList: null,
						afterInDetail: null,
					},
				]).modules[moduleUuid].caseListConfig?.columns,
			).toContainEqual(value);
		}
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
			// The type-compatibility predicate has no opinion on
			// existence; authoring affordances apply that separate gate.
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
