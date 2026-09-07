import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { arith, formField, literal, term } from "@/lib/domain/predicate";

/** One admitted workflow consumed by both native Core and the real SQL store. */
export function arithmeticFixture() {
	const formUuid = testUuid("arithmetic-form");
	const numerator = testUuid("arithmetic-numerator");
	const denominator = testUuid("arithmetic-denominator");
	const decimal = testUuid("arithmetic-decimal");
	const doc = buildDoc({
		appName: "Arithmetic evidence",
		caseTypes: [
			{
				name: "patient",
				properties: ["quotient", "remainder", "large", "mixed"].map((name) => ({
					name,
					label: proseText(name),
					data_type: name === "mixed" ? ("decimal" as const) : ("int" as const),
				})),
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: formUuid,
						name: "Calculate",
						type: "followup",
						fields: [
							f({ uuid: numerator, id: "numerator", kind: "int" }),
							f({ uuid: denominator, id: "denominator", kind: "int" }),
							f({ uuid: decimal, id: "decimal", kind: "decimal" }),
						],
					},
				],
			},
		],
	});
	doc.forms[formUuid].caseOperations = [
		{
			uuid: testUuid("arithmetic-operation"),
			id: "calculate",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: [
				{
					property: "quotient",
					value: arith(
						"div",
						term(formField(numerator)),
						term(formField(denominator)),
					),
				},
				{
					property: "remainder",
					value: arith(
						"mod",
						term(formField(numerator)),
						term(formField(denominator)),
					),
				},
				{
					property: "mixed",
					value: arith(
						"div",
						term(formField(decimal)),
						term(formField(denominator)),
					),
				},
				{
					property: "large",
					value: arith("div", term(literal(2147483648)), term(literal(3))),
				},
			],
		},
	];
	return { doc, formUuid };
}
