// Hidden Value writer agreement through the complete validator: a Hidden
// Value that saves to a case property is held to the property's type, so a
// follow-up question that fills itself from the property never opens on a
// value it can't cast. Each refusal sits beside the neighbour that differs
// from it in one fact.

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
import type { BlueprintDoc } from "@/lib/domain";
import { ifExpr } from "@/lib/domain/expression/builders";
import { inferExpressionTypes } from "@/lib/domain/expression/inference";
import { runValidation } from "../runner";

const REGISTER = testUuid("writer-agreement-register");
const FOLLOW_UP = testUuid("writer-agreement-follow-up");
const CHECK_IN = testUuid("writer-agreement-check-in");
const uuid = (name: string) => testUuid(`writer-agreement-${name}`);

type Properties = NonNullable<
	NonNullable<Parameters<typeof buildDoc>[0]>["caseTypes"]
>[number]["properties"];

function doc(args: {
	readonly register?: FieldSpec[];
	readonly followUp?: FieldSpec[];
	/** A second follow-up form, for a writer beside the follow-up's own. */
	readonly checkIn?: FieldSpec[];
	readonly properties?: Properties;
}): BlueprintDoc {
	return buildDoc({
		appName: "Writer agreement",
		caseTypes: [{ name: "patient", properties: args.properties ?? [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: REGISTER,
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								label: "Name",
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({ kind: "text", id: "flag", label: "Flag" }),
							...(args.register ?? []),
						],
					},
					{
						uuid: FOLLOW_UP,
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "remark", label: "Remark" }),
							...(args.followUp ?? []),
						],
					},
					{
						uuid: CHECK_IN,
						name: "Check-in",
						type: "followup",
						fields: [
							f({ kind: "text", id: "comment", label: "Comment" }),
							...(args.checkIn ?? []),
						],
					},
				],
			},
		],
	});
}

const hidden = (
	name: string,
	value: { calculate: string } | { default_value: string },
	property?: string,
): FieldSpec =>
	f({
		uuid: uuid(name),
		kind: "hidden",
		id: name,
		...value,
		...(property === undefined
			? {}
			: { caseWrite: { caseType: "patient", property } }),
	});

/** The follow-up date question every Hidden-writer document shares: it
 * writes `visit_date` and fills itself from it when the form opens. */
const visitDateQuestion = f({
	uuid: uuid("visit-date"),
	kind: "date",
	id: "visit_date",
	label: "Visit date",
	caseWrite: { caseType: "patient", property: "visit_date" },
});

/** A text property the follow-up's copy reads. */
const noteQuestion = f({
	kind: "text",
	id: "note",
	label: "Note",
	caseWrite: { caseType: "patient", property: "note" },
});

const validate = (built: BlueprintDoc) =>
	runValidation(built, LOOKUP_CONTEXT_UNAVAILABLE);

describe("the four Hidden-writer documents", () => {
	it("A: refuses a registration Hidden Value that saves text where a date question reads it back", () => {
		const errors = validate(
			doc({
				register: [
					hidden(
						"stamp",
						{ calculate: "concat('not', '-a-date')" },
						"visit_date",
					),
				],
				followUp: [visitDateQuestion],
			}),
		);
		expect(errors).toEqual([
			expect.objectContaining({
				code: "HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
				scope: "field",
				location: expect.objectContaining({
					formUuid: REGISTER,
					formName: "Register",
					fieldUuid: uuid("stamp"),
					fieldId: "stamp",
					field: "calculate",
				}),
				details: expect.objectContaining({
					caseType: "patient",
					property: "visit_date",
					reason: "type",
					valueType: "text",
					propertyType: "date",
					consequence: "stops-form",
					origin: "field",
					originField: "visit_date",
					originForm: "Visit",
				}),
			}),
		]);
		expect(errors[0].message).toBe(
			'Hidden value "stamp" in "Register" saves text to "visit_date" on "patient", which holds a date (saved by "visit_date" in "Visit"). A form that fills a question from "visit_date" would stop when it opens on a value that isn\'t a date. You can change the calculation so it gives a date, or save it to another property.',
		);
	});

	it("B: keeps a second visible writer under the kind rule", () => {
		const codes = validate(
			doc({
				register: [
					f({
						kind: "text",
						id: "visit_text",
						label: "Visit",
						caseWrite: { caseType: "patient", property: "visit_date" },
					}),
				],
				followUp: [visitDateQuestion],
			}),
		).map(({ code }) => code);
		expect(codes).toEqual([
			"FIELD_KIND_WRITERS_DISAGREE",
			"FIELD_KIND_WRITERS_DISAGREE",
		]);
	});

	it("C: refuses a follow-up Hidden Value copying a text property into the date property", () => {
		const errors = validate(
			doc({
				register: [noteQuestion],
				followUp: [visitDateQuestion],
				checkIn: [hidden("copy", { calculate: "#patient/note" }, "visit_date")],
			}),
		);
		expect(errors).toEqual([
			expect.objectContaining({
				code: "HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
				location: expect.objectContaining({
					formUuid: CHECK_IN,
					fieldUuid: uuid("copy"),
					field: "calculate",
				}),
				details: expect.objectContaining({
					reason: "type",
					valueType: "text",
					propertyType: "date",
				}),
			}),
		]);
	});

	it("D: admits a follow-up Hidden Value today() into the date property", () => {
		expect(
			validate(
				doc({
					followUp: [visitDateQuestion],
					checkIn: [hidden("day", { calculate: "today()" }, "visit_date")],
				}),
			),
		).toEqual([]);
	});
});

describe("a Hidden Value's outputs against the property", () => {
	it("admits a blank branch beside a date", () => {
		expect(
			validate(
				doc({
					register: [
						f({ uuid: uuid("d"), kind: "date", id: "d", label: "D" }),
						hidden(
							"maybe",
							{ calculate: "if(#form/flag = 'yes', '', #form/d)" },
							"visit_date",
						),
					],
					followUp: [visitDateQuestion],
				}),
			),
		).toEqual([]);
	});

	it("names a declared type as the property's type source", () => {
		const errors = validate(
			doc({
				properties: [{ name: "visit_date", label: "Visit", data_type: "date" }],
				register: [
					hidden("stamp", { calculate: "concat('a', 'b')" }, "visit_date"),
				],
			}),
		);
		expect(errors).toEqual([
			expect.objectContaining({
				code: "HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
				details: expect.objectContaining({ origin: "declared" }),
			}),
		]);
		expect(errors[0].message).toContain(
			"which holds a date (as the case type declares it)",
		);
	});

	it.each([
		{ calculate: "#form/a + 1", refused: false },
		{ calculate: "int(#form/a div 2)", refused: false },
		{ calculate: "#form/a * 1.5", refused: true },
	])(
		"judges $calculate saved to an integer property",
		({ calculate, refused }) => {
			const errors = validate(
				doc({
					properties: [{ name: "score", label: "Score", data_type: "int" }],
					register: [
						f({ uuid: uuid("a"), kind: "int", id: "a", label: "A" }),
						hidden("total", { calculate }, "score"),
					],
				}),
			);
			expect(errors).toEqual(
				refused
					? [
							expect.objectContaining({
								code: "HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
								details: expect.objectContaining({
									reason: "type",
									valueType: "decimal",
									propertyType: "int",
								}),
							}),
						]
					: [],
			);
		},
	);

	it("names a starting value as what to change", () => {
		const errors = validate(
			doc({
				properties: [{ name: "score", label: "Score", data_type: "int" }],
				register: [hidden("total", { default_value: "'high'" }, "score")],
			}),
		);
		expect(errors).toEqual([
			expect.objectContaining({
				code: "HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
				location: expect.objectContaining({ field: "default_value" }),
			}),
		]);
		expect(errors[0].message).toContain("You can change the starting value");
	});
});

describe("one finding per writer, its consequence told by the property's type", () => {
	it("refuses a writer whose two results don't fit a date once, naming both paths, beside one that fits", () => {
		const errors = validate(
			doc({
				register: [
					hidden(
						"when",
						{ calculate: "if(#form/flag = 'yes', 'soon', 'later')" },
						"visit_date",
					),
				],
				followUp: [visitDateQuestion],
			}),
		);
		expect(errors).toEqual([
			expect.objectContaining({
				code: "HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
				location: expect.objectContaining({ fieldUuid: uuid("when") }),
				details: expect.objectContaining({
					reason: "type",
					valueType: "text",
					paths: JSON.stringify([
						["if", "then"],
						["if", "else"],
					]),
				}),
			}),
		]);
		expect(errors[0].message).toContain(
			'saves text to "visit_date" on "patient", which holds a date',
		);
		expect(
			validate(
				doc({
					register: [
						hidden(
							"when",
							{ calculate: "if(#form/flag = 'yes', today(), '')" },
							"visit_date",
						),
					],
					followUp: [visitDateQuestion],
				}),
			),
		).toEqual([]);
	});

	it("names several choices apart from text, and tells what a choice property's readers get", () => {
		const errors = validate(
			doc({
				properties: [
					{ name: "tags", label: "Tags", data_type: "multi_select" },
				],
				register: [hidden("tag", { calculate: "concat('a', 'b')" }, "tags")],
			}),
		);
		expect(errors).toEqual([
			expect.objectContaining({
				code: "HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
				details: expect.objectContaining({
					reason: "type",
					valueType: "text",
					propertyType: "multi_select",
					consequence: "wrong-kind",
				}),
			}),
		]);
		expect(errors[0].message).toBe(
			'Hidden value "tag" in "Register" saves text to "tags" on "patient", which holds several choices (as the case type declares it). Forms and case lists that read "tags" would get text where they expect several choices. You can change the calculation so it gives several choices, or save it to another property.',
		);
	});

	it("tells a choice property's readers get a number, beside a whole-number property's form that stops", () => {
		const choice = validate(
			doc({
				properties: [
					{ name: "stage", label: "Stage", data_type: "single_select" },
				],
				register: [hidden("count", { calculate: "1 + 1" }, "stage")],
			}),
		);
		expect(choice).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					valueType: "int",
					consequence: "wrong-kind",
				}),
			}),
		]);
		expect(choice[0].message).toContain(
			'Forms and case lists that read "stage" would get a whole number where they expect a choice.',
		);
		const whole = validate(
			doc({
				properties: [{ name: "score", label: "Score", data_type: "int" }],
				register: [hidden("half", { calculate: "1.5" }, "score")],
			}),
		);
		expect(whole).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ consequence: "stops-form" }),
			}),
		]);
		expect(whole[0].message).toContain(
			"would stop when it opens on a value that isn't a whole number",
		);
	});
});

describe("Hidden Values that alone type a property", () => {
	it("agrees an integer and a decimal on a decimal", () => {
		const built = doc({
			register: [hidden("whole", { calculate: "1" }, "amount")],
			followUp: [hidden("part", { calculate: "1.5" }, "amount")],
		});
		expect(validate(built)).toEqual([]);
		expect(
			inferExpressionTypes(built)
				.caseTypes.find((type) => type.name === "patient")
				?.properties.find((property) => property.name === "amount")?.data_type,
		).toBe("decimal");
	});

	it("reports each Hidden writer of a disagreement", () => {
		const errors = validate(
			doc({
				register: [hidden("number", { calculate: "1" }, "score")],
				followUp: [hidden("words", { calculate: "'high'" }, "score")],
			}),
		);
		expect(
			errors.map(({ code, location, details }) => [
				code,
				location.fieldUuid,
				details?.reason,
			]),
		).toEqual([
			[
				"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
				uuid("number"),
				"hidden-disagreement",
			],
			[
				"HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
				uuid("words"),
				"hidden-disagreement",
			],
		]);
		expect(errors[0].message).toContain(
			'saves a whole number to "score" on "patient", and other hidden values save text there',
		);
		expect(errors.map(({ details }) => details?.disagreement)).toEqual([
			"others",
			"others",
		]);
	});

	it("reports a writer whose own results disagree once, as its own disagreement", () => {
		const errors = validate(
			doc({
				register: [
					hidden(
						"mixed",
						{ calculate: "if(#form/flag = 'yes', 1, 'high')" },
						"score",
					),
				],
			}),
		);
		expect(errors).toEqual([
			expect.objectContaining({
				code: "HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
				location: expect.objectContaining({ fieldUuid: uuid("mixed") }),
				details: expect.objectContaining({
					reason: "hidden-disagreement",
					disagreement: "own",
					paths: JSON.stringify([
						["if", "then"],
						["if", "else"],
					]),
				}),
			}),
		]);
		expect(errors[0].message).toBe(
			'Hidden value "mixed" in "Register" saves a whole number or text to "score" on "patient" from different results, so the property has no one type. A form that fills a question from "score" can\'t know what it holds. You can make every result of the calculation give the same kind of value, or save it to another property.',
		);
	});

	it("admits a writer copying the property it writes, which stays unknown", () => {
		const built = doc({
			followUp: [hidden("total", { calculate: "#patient/total + 1" }, "total")],
		});
		expect(validate(built)).toEqual([]);
		expect(
			inferExpressionTypes(built)
				.caseTypes.find((type) => type.name === "patient")
				?.properties.find((property) => property.name === "total")?.data_type,
		).toBeUndefined();
	});
});

describe("a starting value the form's preload overwrites", () => {
	it("admits a follow-up starting value on its own case's property, beside the same calculation refused", () => {
		const startingValue = validate(
			doc({
				followUp: [visitDateQuestion],
				checkIn: [hidden("seed", { default_value: "'soon'" }, "visit_date")],
			}),
		);
		expect(startingValue).toEqual([]);
		const calculated = validate(
			doc({
				followUp: [visitDateQuestion],
				checkIn: [hidden("seed", { calculate: "'soon'" }, "visit_date")],
			}),
		).map(({ code }) => code);
		expect(calculated).toEqual(["HIDDEN_VALUE_WRITER_TYPE_MISMATCH"]);
	});
});

describe("a date and time whose clock an earlier Hidden Value dropped", () => {
	const seenAt: Properties = [
		{ name: "seen_at", label: "Seen at", data_type: "datetime" },
	];

	it("refuses a copy of a string-bound now() saved to a date-and-time property", () => {
		const errors = validate(
			doc({
				properties: seenAt,
				register: [
					hidden("stamp", { calculate: "now()" }),
					hidden("copy", { calculate: "#form/stamp" }, "seen_at"),
				],
			}),
		);
		expect(errors).toEqual([
			expect.objectContaining({
				code: "HIDDEN_VALUE_WRITER_TYPE_MISMATCH",
				location: expect.objectContaining({ fieldUuid: uuid("copy") }),
				details: expect.objectContaining({
					reason: "clock-lost",
					propertyType: "datetime",
					clockSource: "stamp",
				}),
			}),
		]);
		expect(errors[0].message).toContain(
			'the value keeps only the day because "stamp" doesn\'t keep the time',
		);
		expect(errors[0].message).toContain(
			"You can save it from a question or from now() instead.",
		);
	});

	it("refuses a case operation saving the same copy, beside one saving now()", () => {
		const stampTerm = {
			kind: "term",
			term: { kind: "field", uuid: uuid("stamp") },
		} as const;
		const withWrite = (value: "copy" | "now" | "copy-or-text") => {
			const built = doc({
				properties: seenAt,
				checkIn: [hidden("stamp", { calculate: "now()" })],
			});
			built.forms[CHECK_IN].caseOperations = [
				{
					uuid: uuid("operation"),
					id: "mark_seen",
					action: "update",
					caseType: "patient",
					target: { kind: "session" },
					writes: [
						{
							property: "seen_at",
							value:
								value === "copy"
									? stampTerm
									: value === "copy-or-text"
										? ifExpr(
												{
													kind: "is-blank",
													left: {
														kind: "term",
														term: { kind: "field", uuid: uuid("comment") },
													},
												},
												stampTerm,
												{
													kind: "term",
													term: { kind: "literal", value: "abc" },
												},
											)
										: { kind: "now" },
						},
					],
				},
			];
			return validate(built);
		};
		expect(withWrite("copy")).toEqual([
			expect.objectContaining({
				code: "CASE_OPERATION_EXPRESSION_TYPE",
				location: expect.objectContaining({ field: uuid("operation") }),
				details: expect.objectContaining({ reason: "clock-lost" }),
			}),
		]);
		expect(withWrite("now")).toEqual([]);
		// Text beside the lost clock is the ordinary refusal, not the midnight one.
		const mixed = withWrite("copy-or-text");
		expect(mixed).toEqual([
			expect.objectContaining({
				code: "CASE_OPERATION_EXPRESSION_TYPE",
				details: expect.not.objectContaining({ reason: "clock-lost" }),
			}),
		]);
		expect(userFacingError(mixed[0])).toBe(
			"A value or condition in this case operation doesn't fit where it's used. Review the highlighted operation.",
		);
	});

	it("admits now() saved straight to the date-and-time property", () => {
		expect(
			validate(
				doc({
					properties: seenAt,
					register: [
						hidden("stamp", { calculate: "now()" }),
						hidden("copy", { calculate: "now()" }, "seen_at"),
					],
				}),
			),
		).toEqual([]);
	});
});
