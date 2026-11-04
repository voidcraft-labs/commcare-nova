import { describe, expect, it } from "vitest";
import { type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	blueprintDocSchema,
	type CasePropertyDataType,
	effectiveCaseTypes,
	fieldCaseWriteViews,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	admittedCaseListDoc,
	findings,
} from "../case-list/__tests__/caseListRuleFixture";

const mismatch = "FIELD_KIND_PROPERTY_TYPE_MISMATCH";
const disagree = "FIELD_KIND_WRITERS_DISAGREE";
function checked<T extends Parameters<typeof findings>[0]>(doc: T): T {
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return doc;
}

describe("case writer type admission", () => {
	it.each([
		{ kind: "text", type: "text" },
		{ kind: "barcode", type: "text" },
		{ kind: "secret", type: "text" },
		{ kind: "single_select", type: "single_select" },
		{ kind: "multi_select", type: "multi_select" },
		{ kind: "int", type: "int" },
		{ kind: "decimal", type: "decimal" },
		{ kind: "date", type: "date" },
		{ kind: "datetime", type: "datetime" },
		{ kind: "time", type: "time" },
		{ kind: "geopoint", type: "geopoint" },
	] satisfies { kind: FieldSpec["kind"]; type: CasePropertyDataType }[])(
		"$kind writer fits its own $type catalog type and not a location",
		({ kind, type }) => {
			const base = admittedCaseListDoc({
				fields: [
					f({
						kind,
						id: "value",
						label: "Value",
						...(kind === "single_select" || kind === "multi_select"
							? {
									options: [
										{ value: "a", label: "A" },
										{ value: "b", label: "B" },
									],
								}
							: {}),
						caseWrite: { caseType: "patient", property: "value" },
					}),
				],
			});
			for (const declared of [
				type,
				type === "geopoint" ? "int" : "geopoint",
			] satisfies CasePropertyDataType[]) {
				const doc = checked({
					...base,
					caseTypes: [
						{
							name: "patient",
							properties: [
								{
									name: "value",
									label: proseText("Value"),
									data_type: declared,
								},
							],
						},
					],
				});
				const errors = findings(doc);
				expect(errors.map((error) => error.code)).toEqual(
					declared === type ? [] : [mismatch],
				);
				if (errors.length)
					expect(errors[0].details).toMatchObject({
						expectedDataType: type,
						declaredDataType: declared,
						property: "value",
					});
			}
		},
	);
	// A declared type holds an integer as a decimal and a choice as text,
	// which its readers read back; free text saved to a declared choice
	// property would reach a choice question that starts on it with a value
	// it may not offer.
	it.each([
		{ kind: "int", declared: "decimal", fits: true },
		{ kind: "single_select", declared: "text", fits: true },
		{ kind: "text", declared: "single_select", fits: false },
		{ kind: "barcode", declared: "single_select", fits: false },
		{ kind: "decimal", declared: "int", fits: false },
		{ kind: "multi_select", declared: "text", fits: false },
		{ kind: "text", declared: "multi_select", fits: false },
		{ kind: "single_select", declared: "multi_select", fits: false },
		{ kind: "date", declared: "datetime", fits: false },
		{ kind: "int", declared: "text", fits: false },
	] satisfies {
		kind: FieldSpec["kind"];
		declared: CasePropertyDataType;
		fits: boolean;
	}[])(
		"a $kind writer into a declared $declared property fits: $fits",
		({ kind, declared, fits }) => {
			const base = admittedCaseListDoc({
				fields: [
					f({
						kind,
						id: "value",
						label: "Value",
						...(kind === "single_select" || kind === "multi_select"
							? {
									options: [
										{ value: "a", label: "A" },
										{ value: "b", label: "B" },
									],
								}
							: {}),
						caseWrite: { caseType: "patient", property: "value" },
					}),
				],
			});
			const doc = checked({
				...base,
				caseTypes: [
					{
						name: "patient",
						properties: [
							{ name: "value", label: proseText("Value"), data_type: declared },
						],
					},
				],
			});
			expect(findings(doc).map((error) => error.code)).toEqual(
				fits ? [] : [mismatch],
			);
		},
	);
	it.each(["case_name", "external_id"])(
		"keeps implicit %s text-shaped",
		(property) => {
			const base = admittedCaseListDoc({
				fields:
					property === "external_id"
						? [
								f({
									kind: "text",
									id: "code",
									label: "Code",
									caseWrite: { caseType: "patient", property },
								}),
							]
						: [],
			});
			const writer = Object.values(base.fields).find((field) =>
				fieldCaseWriteViews(base, field.uuid).some(
					(view) => view.property === property,
				),
			);
			if (writer?.kind !== "text") throw new Error("Missing writer");
			const candidate = checked({
				...base,
				fields: {
					...base.fields,
					[writer.uuid]: { ...writer, kind: "int" as const },
				},
			});
			expect(findings(candidate).map((error) => error.code)).toEqual([
				mismatch,
			]);
		},
	);
	// Writers agree on the one of their types that holds every other: an
	// integer and a decimal on decimal, a choice and text on text. Where none
	// does, each writer is a finding.
	it.each([
		{ first: "int", second: "decimal", agreed: "decimal" },
		{ first: "single_select", second: "text", agreed: "text" },
		{ first: "int", second: "text", agreed: undefined },
		{ first: "single_select", second: "multi_select", agreed: undefined },
	] satisfies {
		first: FieldSpec["kind"];
		second: FieldSpec["kind"];
		agreed: CasePropertyDataType | undefined;
	}[])(
		"a $first writer and a $second writer in another form agree on $agreed",
		({
			first,
			second,
			agreed,
		}: {
			first: FieldSpec["kind"];
			second: FieldSpec["kind"];
			agreed: CasePropertyDataType | undefined;
		}) => {
			const spec = (id: string, kind: FieldSpec["kind"]) =>
				f({
					kind,
					id,
					label: "Weight",
					...(kind === "single_select"
						? {
								options: [
									{ value: "a", label: "A" },
									{ value: "b", label: "B" },
								],
							}
						: {}),
					caseWrite: { caseType: "patient", property: "weight" },
				});
			// Admitted with both writers of the first kind, then the later one
			// takes the second kind.
			const base = admittedCaseListDoc({
				fields: [spec("initial", first)],
				additionalForms: [
					{
						name: "Followup",
						type: "followup",
						fields: [spec("updated", first)],
					},
				],
			});
			const later = Object.values(base.fields).find(
				(field) => field.id === "updated",
			);
			if (later === undefined) throw new Error("Missing later writer");
			// A choice's source stays with a choice kind, and leaves any other.
			const { optionsSource, ...plain } = later as typeof later & {
				optionsSource?: unknown;
			};
			const doc = checked({
				...base,
				fields: {
					...base.fields,
					[later.uuid]: {
						...plain,
						kind: second,
						...(second === "single_select" || second === "multi_select"
							? { optionsSource }
							: {}),
					} as typeof later,
				},
			});
			const writers = Object.values(doc.fields).filter((field) =>
				fieldCaseWriteViews(doc, field.uuid).some(
					(view) => view.property === "weight",
				),
			);
			expect(writers.map((writer) => writer.kind).sort()).toEqual(
				[first, second].sort(),
			);
			expect(
				findings(doc).map((error) => ({
					code: error.code,
					uuid: error.location.fieldUuid,
				})),
			).toEqual(
				agreed === undefined
					? writers.map((writer) => ({ code: disagree, uuid: writer.uuid }))
					: [],
			);
			expect(
				effectiveCaseTypes(doc)
					.find((type) => type.name === "patient")
					?.properties.find((property) => property.name === "weight")
					?.data_type,
			).toBe(agreed);
		},
	);
	it("collects a nested group writer and leaves a calculate-driven hidden writer to expression typing", () => {
		const base = admittedCaseListDoc({
			fields: [
				f({
					kind: "group",
					id: "details",
					label: "Details",
					children: [
						f({
							kind: "int",
							id: "weight",
							label: "Weight",
							caseWrite: { caseType: "patient", property: "weight" },
						}),
					],
				}),
				f({
					kind: "hidden",
					id: "computed",
					calculate: "1",
					caseWrite: { caseType: "patient", property: "computed" },
				}),
			],
		});
		const doc = checked({
			...base,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "weight",
							label: proseText("Weight"),
							data_type: "text" as const,
						},
						{
							name: "computed",
							label: proseText("Computed"),
							data_type: "int" as const,
						},
					],
				},
			],
		});
		const errors = findings(doc);
		expect(errors.map((error) => error.code)).toEqual([mismatch]);
		expect(errors[0].location.fieldId).toBe("weight");
	});
});
