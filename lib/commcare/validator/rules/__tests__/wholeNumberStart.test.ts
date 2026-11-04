// A whole-number question never starts on a decimal number, which
// `IntegerData.cast` can't read as the form opens. The plausible failures: a
// decimal starting value admitted because the default slot checks no type, a
// property made decimal by a writer in another form left unseen, and a
// starting value that only names the property refused where it holds whole
// numbers.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc, CasePropertyDataType } from "@/lib/domain";
import { runValidation } from "../../runner";

const COUNT = testUuid("whole-start-count");

function doc(args: {
	readonly weight?: CasePropertyDataType;
	readonly register?: FieldSpec[];
	readonly visit: FieldSpec[];
}): BlueprintDoc {
	return buildDoc({
		appName: "Whole numbers",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{
						name: "weight",
						label: "Weight",
						...(args.weight !== undefined && { data_type: args.weight }),
					},
				],
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
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							...(args.register ?? []),
						],
					},
					{ name: "Visit", type: "followup", fields: args.visit },
				],
			},
		],
	});
}

const count = (defaultValue: string, saves = false) =>
	f({
		uuid: COUNT,
		kind: "int",
		id: "count",
		default_value: defaultValue,
		...(saves && { caseWrite: { caseType: "patient", property: "weight" } }),
	});
const codes = (built: BlueprintDoc) =>
	runValidation(built, LOOKUP_CONTEXT_UNAVAILABLE).map((error) => error.code);

describe("a whole-number question's starting value", () => {
	it("refuses a read of a declared decimal property, naming it", () => {
		const errors = runValidation(
			doc({ weight: "decimal", visit: [count("#patient/weight", true)] }),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(errors).toEqual([
			expect.objectContaining({
				code: "WHOLE_NUMBER_STARTS_ON_DECIMAL",
				location: expect.objectContaining({
					fieldUuid: COUNT,
					field: "default_value",
				}),
				details: { caseType: "patient", property: "weight" },
			}),
		]);
		expect(errors[0]?.message).toBe(
			'Question "count" in "Visit" starts on "weight" from the case, which holds decimal numbers, and CommCare stops a form when a whole-number question opens on a decimal number. You can make "count" a decimal question, or start it on the whole part, int(#patient/weight).',
		);
		expect(errors[0] && userFacingError(errors[0])).toBe(
			`"count" starts on the case's "weight", which holds decimal numbers, and the form would stop when a whole-number question opens on one. You can make it a decimal question, or start it on the whole part with int(...).`,
		);
	});

	// An integer writer beside a decimal one agrees on decimal, so a decimal
	// question in another form makes the property hold decimals.
	it("refuses a read of a property a decimal question in another form writes", () => {
		const decimalWriter = f({
			kind: "decimal",
			id: "weight",
			caseWrite: { caseType: "patient", property: "weight" },
		});
		expect(
			codes(
				doc({
					register: [decimalWriter],
					visit: [count("#patient/weight", true)],
				}),
			),
		).toEqual(["WHOLE_NUMBER_STARTS_ON_DECIMAL"]);
	});

	it.each([
		["a read of a whole-number property", "int", "#patient/weight"],
		["the whole part of a decimal property", "decimal", "int(#patient/weight)"],
		["a property nothing types", undefined, "#patient/weight"],
	] as const)("admits %s", (_what, weight, value) => {
		expect(codes(doc({ weight, visit: [count(value)] }))).toEqual([]);
	});

	it("refuses a decimal calculation, naming no property", () => {
		const errors = runValidation(
			doc({ visit: [count("1 div 2")] }),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(errors.map((error) => [error.code, error.details])).toEqual([
			["WHOLE_NUMBER_STARTS_ON_DECIMAL", {}],
		]);
	});
});
