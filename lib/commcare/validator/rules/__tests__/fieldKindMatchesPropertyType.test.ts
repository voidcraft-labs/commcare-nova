import { describe, expect, it } from "vitest";
import { type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { blueprintDocSchema, type CasePropertyDataType } from "@/lib/domain";
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
		"$kind writer agrees only with its concrete $type catalog type",
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
				type === "text" ? "int" : "text",
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
			const writer = Object.values(base.fields).find(
				(field) =>
					"caseWrite" in field && field.caseWrite?.property === property,
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
	it("attributes cross-form disagreement to every writer and admits agreement", () => {
		const spec = (id: string) =>
			f({
				kind: "int",
				id,
				label: "Weight",
				caseWrite: { caseType: "patient", property: "weight" },
			});
		const base = admittedCaseListDoc({
			fields: [spec("initial")],
			additionalForms: [
				{ name: "Followup", type: "followup", fields: [spec("updated")] },
			],
		});
		const writers = Object.values(base.fields).filter(
			(field) => "caseWrite" in field && field.caseWrite?.property === "weight",
		);
		const later = writers.find((field) => field.id === "updated");
		if (later?.kind !== "int") throw new Error("Missing later writer");
		const candidate = checked({
			...base,
			fields: {
				...base.fields,
				[later.uuid]: { ...later, kind: "decimal" as const },
			},
		});
		expect(
			findings(candidate).map((error) => ({
				code: error.code,
				uuid: error.location.fieldUuid,
			})),
		).toEqual(writers.map((writer) => ({ code: disagree, uuid: writer.uuid })));
	});
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
