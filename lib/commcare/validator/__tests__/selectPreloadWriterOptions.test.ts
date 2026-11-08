// A fixed value saved into a property that a choice question starts on must
// be one of its choices, through the complete validator. The reader is a
// follow-up select with written choices that fills itself from the case it
// opens; the writers sit in other forms. Each refusal sits beside the
// neighbour that differs from it in one fact.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, CaseOperation } from "@/lib/domain";
import type { Expression } from "@/lib/domain/expression/types";
import { runValidation } from "../runner";
import { ownArms } from "./ownArms";

const REGISTER = testUuid("preload-options-register");
const VISIT = testUuid("preload-options-visit");
const CHECK_IN = testUuid("preload-options-check-in");
const READER = testUuid("preload-options-status");
const WRITER = testUuid("preload-options-writer");
const OPERATION = testUuid("preload-options-operation");
const CODE = "SELECT_PRELOAD_WRITE_NOT_AN_OPTION";

function doc(args: {
	readonly reader?: "single_select" | "multi_select";
	readonly options?: readonly string[];
	readonly readerSource?: "inline" | "cases";
	readonly register?: FieldSpec[];
	readonly checkIn?: FieldSpec[];
}): BlueprintDoc {
	const options = args.options ?? ["a", "b"];
	return buildDoc({
		appName: "Preload options",
		caseTypes: [
			{ name: "patient", properties: [{ name: "stage", label: "Stage" }] },
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
						uuid: VISIT,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: READER,
								kind: args.reader ?? "single_select",
								id: "status_question",
								label: "Status",
								caseWrite: { caseType: "patient", property: "stage" },
								optionsSource:
									args.readerSource === "cases"
										? {
												kind: "cases",
												caseType: "patient",
												labelProperty: "case_name",
											}
										: {
												kind: "inline",
												options: options.map((value) => ({
													value,
													label: value,
												})),
											},
							}),
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

const hiddenWriter = (
	value:
		| { readonly calculate: string | Expression }
		| { readonly default_value: string | Expression },
): FieldSpec =>
	f({
		uuid: WRITER,
		kind: "hidden",
		id: "status_value",
		...value,
		caseWrite: { caseType: "patient", property: "stage" },
	});

const literal = (
	value: string | number,
	data_type?: "single_select" | "multi_select",
): Expression => ({
	kind: "term",
	term: {
		kind: "literal",
		value,
		...(data_type === undefined ? {} : { data_type }),
	},
});

function withOperation(
	built: BlueprintDoc,
	write: CaseOperation["writes"],
): BlueprintDoc {
	built.forms[CHECK_IN].caseOperations = [
		...ownArms(built.forms[CHECK_IN]),
		{
			uuid: OPERATION,
			id: "mark_status",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
			writes: write,
		},
	];
	return built;
}

const validate = (built: BlueprintDoc) =>
	runValidation(built, LOOKUP_CONTEXT_UNAVAILABLE);
const ofCode = (built: BlueprintDoc) =>
	validate(built).filter(({ code }) => code === CODE);

describe("a Hidden Value's literal into a property a choice question starts on", () => {
	it("refuses a value that is none of the choices, located at the writer", () => {
		const errors = validate(
			doc({ register: [hiddenWriter({ calculate: "'z'" })] }),
		);
		expect(errors).toEqual([
			expect.objectContaining({
				code: CODE,
				scope: "field",
				location: expect.objectContaining({
					formUuid: REGISTER,
					fieldUuid: WRITER,
					fieldId: "status_value",
					field: "calculate",
				}),
				details: {
					value: "z",
					caseType: "patient",
					property: "stage",
					readerField: "status_question",
					readerFieldUuid: READER,
					readerForm: "Visit",
					readerFormUuid: VISIT,
					options: "a, b",
				},
			}),
		]);
		expect(errors[0].message).toBe(
			'Hidden value "status_value" in "Register" saves "z" to "stage" on "patient", which "status_question" in "Visit" starts on, and "z" isn\'t one of its choices (a, b). CommCare\'s Web Apps can\'t open a form whose choice question starts on a value it doesn\'t offer. You can save one of its choices, like \'a\', or save to another property.',
		);
	});

	it.each([
		{ label: "one of the choices", calculate: "'a'" },
		{ label: "a blank value", calculate: "''" },
		{ label: "a computed value", calculate: "concat('a', '')" },
	])("admits $label", ({ calculate }) => {
		expect(validate(doc({ register: [hiddenWriter({ calculate })] }))).toEqual(
			[],
		);
	});

	it("reads a number as its answer text", () => {
		// The type rule judges whether a number fits a choice property; this
		// rule asks only whether its text is a choice.
		expect(
			ofCode(
				doc({
					options: ["1", "2"],
					register: [hiddenWriter({ calculate: literal(1) })],
				}),
			),
		).toEqual([]);
		expect(
			ofCode(doc({ register: [hiddenWriter({ calculate: literal(1) })] })),
		).toHaveLength(1);
	});

	it("judges a registration starting value, which no preload overwrites", () => {
		expect(
			ofCode(doc({ register: [hiddenWriter({ default_value: "'z'" })] })),
		).toEqual([
			expect.objectContaining({
				location: expect.objectContaining({ field: "default_value" }),
			}),
		]);
	});

	it("judges a follow-up starting value as it judges the same calculation", () => {
		// A preload is itself a starting value that reads the case, so nothing
		// runs after a literal one and replaces it.
		for (const slot of ["default_value", "calculate"] as const) {
			expect(
				ofCode(
					doc({
						checkIn: [
							hiddenWriter(
								slot === "default_value"
									? { default_value: "'z'" }
									: { calculate: "'z'" },
							),
						],
					}),
				),
			).toEqual([
				expect.objectContaining({
					location: expect.objectContaining({
						formUuid: CHECK_IN,
						field: slot,
					}),
				}),
			]);
		}
	});
});

describe("a multiple-choice reader", () => {
	it("refuses a value with a token that is none of the choices", () => {
		expect(
			ofCode(
				doc({
					reader: "multi_select",
					register: [hiddenWriter({ calculate: "'a z'" })],
				}),
			),
		).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ value: "a z" }),
			}),
		]);
	});

	it("admits tokens that are all choices", () => {
		// Text into a multiple-choice property is the type rule's question;
		// this rule asks only whether every token is a choice.
		expect(
			ofCode(
				doc({
					reader: "multi_select",
					register: [hiddenWriter({ calculate: "'a b'" })],
				}),
			),
		).toEqual([]);
	});

	it("separates tokens only at spaces, as Core's splitOnSpaces does", () => {
		expect(
			ofCode(
				doc({
					reader: "multi_select",
					register: [hiddenWriter({ calculate: literal("a\tb") })],
				}),
			),
		).toHaveLength(1);
	});
});

describe("a case operation's literal write", () => {
	it("refuses a value that is none of the choices, located at the operation", () => {
		const errors = validate(
			withOperation(doc({}), [{ property: "stage", value: literal("z") }]),
		);
		expect(errors).toEqual([
			expect.objectContaining({
				code: CODE,
				scope: "form",
				location: expect.objectContaining({
					formUuid: CHECK_IN,
					formName: "Check-in",
					field: OPERATION,
				}),
				details: expect.objectContaining({
					operationUuid: OPERATION,
					operationId: "mark_status",
					value: "z",
					readerField: "status_question",
				}),
			}),
		]);
		expect(errors[0].message).toMatch(
			/^Case operation "mark_status" in "Check-in" saves "z" to "stage"/,
		);
	});

	it("admits one of the choices", () => {
		expect(
			validate(
				withOperation(doc({}), [{ property: "stage", value: literal("b") }]),
			),
		).toEqual([]);
	});

	it("judges a typed literal by its text", () => {
		expect(
			validate(
				withOperation(doc({ reader: "multi_select" }), [
					{ property: "stage", value: literal("a b", "multi_select") },
				]),
			),
		).toEqual([]);
		expect(
			ofCode(
				withOperation(doc({}), [
					{ property: "stage", value: literal("z", "single_select") },
				]),
			),
		).toHaveLength(1);
	});

	it("judges a conditional write", () => {
		expect(
			ofCode(
				withOperation(doc({}), [
					{
						property: "stage",
						value: literal("z"),
						condition: {
							kind: "eq",
							left: literal("x"),
							right: literal("x"),
						},
					},
				]),
			),
		).toHaveLength(1);
	});
});

describe("readers outside the rule", () => {
	it("admits the same value when the choices come from cases", () => {
		expect(
			ofCode(
				doc({
					readerSource: "cases",
					register: [hiddenWriter({ calculate: "'z'" })],
				}),
			),
		).toEqual([]);
	});

	it("checks explicit starting values even when the form selects several cases", () => {
		const built = doc({ register: [hiddenWriter({ calculate: "'z'" })] });
		const module = built.modules[built.moduleOrder[0]];
		if (module.caseListConfig === undefined)
			throw new Error("The case list fixture is missing.");
		module.caseListConfig.selection = { kind: "multiple", maximum: 10 };
		expect(ofCode(built)).toEqual([expect.objectContaining({ code: CODE })]);
	});
});

describe("choice starting values follow current writer values across the app", () => {
	it("refuses a hidden branch that can write another answer", () => {
		expect(
			ofCode(
				doc({
					register: [
						hiddenWriter({ calculate: "if(#form/flag = 'yes', 'a', 'z')" }),
					],
				}),
			),
		).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ value: "z" }),
			}),
		]);
	});
	it("admits hidden branches and harmless string coercions whose values fit", () => {
		for (const calculate of [
			"if(#form/flag = 'yes', 'a', 'b')",
			"concat('a', '')",
		]) {
			expect(
				validate(doc({ register: [hiddenWriter({ calculate })] })),
			).toEqual([]);
		}
	});
	it("checks a read even when the reading question does not save it back", () => {
		const built = doc({ register: [hiddenWriter({ calculate: "'z'" })] });
		built.forms[VISIT].caseOperations = built.forms[VISIT].caseOperations?.map(
			(operation) => ({ ...operation, writes: [] }),
		);
		expect(ofCode(built)).toHaveLength(1);
	});
	it("refuses a later free-text writer, including when only that form is validated", () => {
		const built = doc({
			register: [
				f({
					kind: "text",
					id: "unbounded",
					caseWrite: { caseType: "patient", property: "stage" },
				}),
			],
		});
		for (const scope of [undefined, { formUuids: new Set([REGISTER]) }]) {
			expect(
				runValidation(built, LOOKUP_CONTEXT_UNAVAILABLE, { scope }).map(
					(error) => error.code,
				),
			).toContain("SELECT_DEFAULT_VALUES_UNBOUNDED");
		}
	});
	it("compares the values of two choice writers, including a later choice edit", () => {
		const built = doc({
			register: [
				f({
					uuid: WRITER,
					kind: "single_select",
					id: "other_stage",
					options: [
						{ value: "a", label: "A" },
						{ value: "z", label: "Z" },
					],
					caseWrite: { caseType: "patient", property: "stage" },
				}),
			],
		});
		expect(ofCode(built)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ value: "z" }),
			}),
		]);
	});
	it("follows a hidden-value chain instead of the hidden field's text type", () => {
		const built = doc({
			register: [
				f({
					kind: "hidden",
					id: "first",
					calculate: "if(#form/flag = 'yes', 'a', 'z')",
				}),
				hiddenWriter({ calculate: "#form/first" }),
			],
		});
		expect(ofCode(built)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ value: "z" }),
			}),
		]);
	});
	it("does not judge values in a branch condition as starting answers", () => {
		const built = doc({
			register: [hiddenWriter({ calculate: "if(#form/flag = 'z', 'a', 'b')" })],
		});
		expect(validate(built)).toEqual([]);
	});
});

it("follows an implicit standard-property read in the writer's form scope", () => {
	const built = withOperation(doc({}), [
		{
			property: "stage",
			value: { kind: "term", term: { kind: "prop", property: "case_name" } },
		},
	]);
	expect(validate(built)).toEqual([
		expect.objectContaining({ code: "SELECT_DEFAULT_VALUES_UNBOUNDED" }),
	]);
});
it.each([" a ", "z"])(
	"judges the stored case name from name and rename writers: %s",
	(renamed) => {
		const built = doc({});
		const registration = built.forms[REGISTER].caseOperations?.find(
			(op) => op.action === "own",
		);
		if (registration?.action !== "own")
			throw new Error("Missing own operation");
		registration.name = literal(" a ");
		registration.writes = registration.writes?.filter(
			(write) => write.property !== "case_name",
		);
		const reader = built.fields[READER];
		if (reader.kind !== "single_select") throw new Error("Missing choice");
		reader.default_value = {
			kind: "term",
			term: { kind: "form-case", caseType: "patient", property: "case_name" },
		};
		built.forms[CHECK_IN].caseOperations = [
			...ownArms(built.forms[CHECK_IN]),
			{
				uuid: OPERATION,
				id: "rename_patient",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				rename: literal(renamed),
			},
		];
		expect(validate(built)).toEqual(
			renamed === "z"
				? [
						expect.objectContaining({
							code: CODE,
							details: expect.objectContaining({
								value: "z",
								property: "case_name",
							}),
						}),
					]
				: [],
		);
	},
);
