import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { parseFixtureExpression } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	formFixture,
	ids,
	requireContext,
} from "@/lib/domain/expression/__tests__/formFixture";
import { checkExpression } from "@/lib/domain/expression/typeChecker";
import type {
	Expression,
	FieldExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { proseText } from "@/lib/domain/prose";
import { formLogicFindings } from "../formLogicFindings";
import { runValidation } from "../runner";

const field = (uuid: typeof ids.time): Expression => ({
	kind: "term",
	term: { kind: "field", uuid },
});
const value = (text: string): Expression => ({
	kind: "term",
	term: { kind: "literal", value: text },
});
describe("time-of-day ordering at an authored slot", () => {
	it.each(["gt", "gte", "lt", "lte"] as const)(
		"refuses %s but retains equality",
		(kind) => {
			const ctx = requireContext(formFixture(), {
				entity: "field",
				uuid: ids.text,
				slot: "relevant",
			});
			expect(
				formLogicFindings(
					{ kind, left: field(ids.time), right: field(ids.time) },
					ctx,
				),
			).toEqual([
				expect.objectContaining({
					code: "XPATH_TIME_ORDERING",
					checkCode: "time-ordering",
					path: [],
				}),
			]);
			expect(
				checkExpression(
					{ kind: "eq", left: field(ids.time), right: value("12:00") },
					ctx,
				).errors,
			).toEqual([]);
		},
	);
	it.each(["relevant", "required", "validate", "default_value"] as const)(
		"keeps the owner of a %s finding",
		(slot) => {
			const ref: FieldExpressionSlotRef = {
				entity: "field",
				uuid: ids.text,
				slot,
			};
			const ctx = requireContext(formFixture(), ref);
			expect(
				formLogicFindings(
					{ kind: "gt", left: field(ids.time), right: field(ids.time) },
					ctx,
				),
			).toContainEqual(
				expect.objectContaining({ code: "XPATH_TIME_ORDERING", slot: ref }),
			);
		},
	);
	it("keeps date ordering and follows a nested time comparison", () => {
		const ctx = requireContext(formFixture(), {
			entity: "field",
			uuid: ids.text,
			slot: "relevant",
		});
		expect(
			checkExpression(
				{ kind: "gt", left: field(ids.date), right: { kind: "today" } },
				ctx,
			).errors,
		).toEqual([]);
		expect(
			checkExpression(
				{
					kind: "not",
					clause: { kind: "gt", left: field(ids.time), right: field(ids.time) },
				},
				ctx,
			).errors,
		).toContainEqual(
			expect.objectContaining({
				code: "time-ordering",
				path: ["not", "clause"],
			}),
		);
	});
});

describe("time ordering findings through the complete validator", () => {
	it.each(["field", "form-link", "connect"] as const)(
		"keeps the %s carrier and its accepted equality neighbour",
		(carrier) => {
			const run = (kind: "gt" | "eq") => {
				const doc = formFixture();
				const comparison: Expression = {
					kind,
					left: {
						kind: "term",
						term: {
							kind: "form-case",
							caseType: "patient",
							property: "appointment",
						},
					},
					right: {
						kind: "term",
						term: {
							kind: "form-case",
							caseType: "patient",
							property: "appointment",
						},
					},
				};
				if (carrier === "field") {
					const field = doc.fields[ids.text];
					if (field.kind !== "text")
						throw new Error("The text question fixture is missing.");
					field.relevant = comparison;
				} else if (carrier === "form-link") {
					const link = doc.forms[ids.form].formLinks?.[0];
					if (link === undefined)
						throw new Error("The link fixture is missing.");
					link.condition = comparison;
					doc.forms[ids.form].postSubmit = "app_home";
				} else {
					doc.connectType = "deliver";
					doc.forms[ids.form].connect = {
						deliver_unit: { id: "visit", name: "Visit", entity_id: comparison },
					};
				}
				return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
			};
			const refused = run("gt");
			expect(refused).toHaveLength(1);
			expect(refused[0]).toMatchObject({
				code: "XPATH_TIME_ORDERING",
				location: { formUuid: ids.form },
				details: { checkCode: "time-ordering" },
			});
			expect(refused[0].location.field).toBe(
				carrier === "field"
					? "relevant"
					: carrier === "form-link"
						? "form_link_condition"
						: "deliver_entity_id",
			);
			expect(run("eq")).toEqual([]);
		},
	);
});

type Carrier = "field" | "form-link" | "connect";
const CARRIERS = ["field", "form-link", "connect"] as const;

/** The complete validator over the fixture with `expression` in one carrier:
 * a question's display condition, an after-submit link's condition, or a
 * Connect delivery's entity id. */
function atCarrier(
	carrier: Carrier,
	expression: Expression,
	configure?: (doc: ReturnType<typeof formFixture>) => void,
) {
	const doc = formFixture();
	configure?.(doc);
	if (carrier === "field") {
		const text = doc.fields[ids.text];
		if (text.kind !== "text")
			throw new Error("The text question fixture is missing.");
		text.relevant = expression;
	} else if (carrier === "form-link") {
		const link = doc.forms[ids.form].formLinks?.[0];
		if (link === undefined) throw new Error("The link fixture is missing.");
		link.condition = expression;
		doc.forms[ids.form].postSubmit = "app_home";
	} else {
		doc.connectType = "deliver";
		doc.forms[ids.form].connect = {
			deliver_unit: { id: "visit", name: "Visit", entity_id: expression },
		};
	}
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
}
const carrierSlot = (carrier: Carrier) =>
	carrier === "field"
		? "relevant"
		: carrier === "form-link"
			? "form_link_condition"
			: "deliver_entity_id";
const now: Expression = { kind: "now" };
/** `true()` as the form parser stores it opposite an answer. */
const trueValue = (() => {
	const parsed = parseFixtureExpression(
		formFixture(),
		{ entity: "field", uuid: ids.text, slot: "relevant" },
		"#form/text = true()",
	);
	if (parsed.kind !== "eq") throw new Error("Expected an equality.");
	return parsed.right;
})();
/** A read of the opened case's property, which every carrier can make. */
const caseRead = (property: string): Expression => ({
	kind: "term",
	term: { kind: "form-case", caseType: "patient", property },
});
/** The fixture's case type with a date, a date-and-time, a number and a
 * text property. */
function withCaseProperties(doc: ReturnType<typeof formFixture>): void {
	const patient = doc.caseTypes?.find((type) => type.name === "patient");
	if (patient === undefined)
		throw new Error("The patient case type fixture is missing.");
	patient.properties.push(
		{ name: "due", label: proseText("Due"), data_type: "date" },
		{ name: "seen_at", label: proseText("Seen at"), data_type: "datetime" },
		{ name: "visits", label: proseText("Visits"), data_type: "int" },
		{ name: "consent", label: proseText("Consent"), data_type: "text" },
	);
}

describe("comparisons whose values don't line up, at every carrier", () => {
	it.each(CARRIERS)(
		"refuses a date against a date and time in a %s, beside the day comparison",
		(carrier) => {
			const refused = atCarrier(
				carrier,
				{ kind: "eq", left: caseRead("due"), right: caseRead("seen_at") },
				withCaseProperties,
			);
			expect(refused).toEqual([
				expect.objectContaining({
					code: "XPATH_INCOMPATIBLE_VALUES",
					location: expect.objectContaining({
						formUuid: ids.form,
						field: carrierSlot(carrier),
					}),
					details: expect.objectContaining({
						reason: "date-datetime",
						checkCode: "incompatible-values",
					}),
				}),
			]);
			expect(refused[0].message).toContain(
				"compares a date with a date and time",
			);
			expect(
				atCarrier(
					carrier,
					{
						kind: "eq",
						left: { kind: "date-coerce", value: caseRead("seen_at") },
						right: caseRead("due"),
					},
					withCaseProperties,
				),
			).toEqual([]);
		},
	);

	it.each(CARRIERS)(
		"refuses a date and time ordered against a number in a %s, beside two dates and times",
		(carrier) => {
			const refused = atCarrier(
				carrier,
				{ kind: "lt", left: caseRead("seen_at"), right: caseRead("visits") },
				withCaseProperties,
			);
			expect(refused).toEqual([
				expect.objectContaining({
					code: "XPATH_INCOMPATIBLE_VALUES",
					details: expect.objectContaining({
						reason: "datetime-ordering",
						otherType: "int",
					}),
				}),
			]);
			expect(refused[0].message).toContain(
				"orders a date and time against a whole number",
			);
			expect(
				atCarrier(
					carrier,
					{ kind: "lt", left: caseRead("seen_at"), right: now },
					withCaseProperties,
				),
			).toEqual([]);
		},
	);

	it.each(CARRIERS)(
		"refuses true() compared with an answer in a %s, beside the choice's value",
		(carrier) => {
			const refused = atCarrier(
				carrier,
				{
					kind: "eq",
					left: caseRead("consent"),
					right: trueValue,
				},
				withCaseProperties,
			);
			expect(refused).toEqual([
				expect.objectContaining({
					code: "XPATH_INCOMPATIBLE_VALUES",
					details: expect.objectContaining({ reason: "boolean" }),
				}),
			]);
			expect(refused[0].message).toContain(
				"compares a true-or-false result with text",
			);
			expect(refused[0].message).toContain(
				"anything that isn't blank or zero counts as true",
			);
			expect(
				atCarrier(
					carrier,
					{ kind: "eq", left: caseRead("consent"), right: value("yes") },
					withCaseProperties,
				),
			).toEqual([]);
		},
	);
});

describe("the operand a comparison refusal names, typed as the checker typed it", () => {
	const relevant = {
		entity: "field",
		uuid: ids.text,
		slot: "relevant",
	} as const;
	const findingsOf = (source: string) => {
		const doc = formFixture();
		return formLogicFindings(
			parseFixtureExpression(doc, relevant, source),
			requireContext(doc, relevant),
		);
	};

	it("names a number, not text, against a date-and-time literal, beside a date-and-time question", () => {
		const refused = findingsOf("'2026-01-01T10:00' > #form/number");
		expect(refused).toEqual([
			expect.objectContaining({
				code: "XPATH_INCOMPATIBLE_VALUES",
				details: { reason: "datetime-ordering", otherType: "int" },
			}),
		]);
		expect(refused[0]?.message).toContain(
			"orders a date and time against a whole number",
		);
		expect(findingsOf("'2026-01-01T10:00' > now()")).toEqual([]);
	});

	it.each([
		{
			source: "selected(#form/choice, 'yes') = 'yes'",
			otherType: "text",
			kind: "text",
		},
		{
			source: "(#form/number > 3) = 'no'",
			otherType: "text",
			kind: "text",
		},
	])(
		"names what $source sets against its true-or-false result",
		({ source, otherType, kind }) => {
			const refused = findingsOf(source);
			expect(refused).toEqual([
				expect.objectContaining({
					code: "XPATH_INCOMPATIBLE_VALUES",
					details: { reason: "boolean", otherType },
				}),
			]);
			expect(refused[0]?.message).toBe(
				`"text" compares a true-or-false result with ${kind} in its display condition. CommCare turns ${kind} into true or false before comparing, and anything that isn't blank or zero counts as true. You can compare the two values themselves, or use the true-or-false result on its own.`,
			);
		},
	);

	it("admits the true-or-false result on its own, and against a number", () => {
		expect(findingsOf("selected(#form/choice, 'yes')")).toEqual([]);
		// A number is true when it isn't zero, so 1 and 0 mean true and false.
		expect(findingsOf("(#form/number > 3) = 1")).toEqual([]);
	});
});

describe("a read of every entry of a repeat where one value is needed", () => {
	const inside = field(ids.inside);
	// An after-submit link runs after the form closes and reads no answer.
	it.each(["field", "connect"] as const)(
		"refuses it in a %s, beside a count of the entries",
		(carrier) => {
			const refused = atCarrier(carrier, {
				kind: "eq",
				left: inside,
				right: value("yes"),
			});
			expect(refused).toEqual([
				expect.objectContaining({
					code: "XPATH_MANY_VALUES",
					location: expect.objectContaining({ field: carrierSlot(carrier) }),
					details: expect.objectContaining({
						reason: "repeat",
						repeatUuid: ids.repeat,
						repeatId: "rows",
					}),
				}),
			]);
			expect(refused[0].message).toContain(
				'reads an answer from every entry of the repeat "rows"',
			);
			expect(
				atCarrier(carrier, {
					kind: "gt",
					left: { kind: "count", via: inside },
					right: { kind: "term", term: { kind: "literal", value: 0 } },
				}),
			).toEqual([]);
		},
	);

	it("admits the read from a question inside the repeat", () => {
		const doc = formFixture();
		const row = doc.fields[ids.inside];
		if (row.kind !== "text")
			throw new Error("The repeat question fixture is missing.");
		const sibling = testUuid("expression-form-sibling");
		doc.fields[sibling] = {
			...row,
			uuid: sibling,
			id: "sibling",
			relevant: { kind: "eq", left: inside, right: value("yes") },
		};
		doc.fieldOrder[ids.repeat] = [
			...(doc.fieldOrder[ids.repeat] ?? []),
			sibling,
		];
		doc.fieldParent[sibling] = ids.repeat;
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	});

	it("refuses it in a label and a validation message, beside the same text inside the repeat", () => {
		const reading = {
			parts: [{ kind: "field-ref" as const, uuid: ids.inside }],
		};
		const withProse = (owner: typeof ids.text) => {
			const doc = formFixture();
			const question = doc.fields[owner];
			if (question.kind !== "text")
				throw new Error("The prose owner fixture is missing.");
			doc.fields[owner] = {
				...question,
				label: reading,
				validate: { kind: "eq", left: field(owner), right: field(owner) },
				validate_msg: reading,
			};
			return doc;
		};
		const refused = runValidation(
			withProse(ids.text),
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(refused).toEqual(
			["label", "validate_msg"].map((slot) =>
				expect.objectContaining({
					code: "XPATH_MANY_VALUES",
					location: expect.objectContaining({ fieldId: "text", field: slot }),
					details: expect.objectContaining({
						reason: "repeat",
						repeatUuid: ids.repeat,
						prose: "true",
					}),
				}),
			),
		);
		// Text can't count or join, so its sentence offers what text can do.
		for (const finding of refused) {
			expect(finding.message).toContain("move this question into the repeat");
			expect(userFacingError(finding)).toContain(
				"move the question into the repeat",
			);
		}
		expect(
			runValidation(withProse(ids.inside), LOOKUP_CONTEXT_UNAVAILABLE),
		).toEqual([]);
	});
});

describe("a time finer than a millisecond", () => {
	it.each(CARRIERS)(
		"refuses it in a %s, beside a millisecond and a minute",
		(carrier) => {
			const at = (text: string): Expression => ({
				kind: "lt",
				left: caseRead("seen_at"),
				right: value(text),
			});
			expect(
				atCarrier(carrier, at("2026-01-01T10:00:00.1234"), withCaseProperties),
			).toEqual([
				expect.objectContaining({
					code: "TYPE_ERROR",
					details: expect.objectContaining({
						reason: "datetime-literal-precision",
						checkCode: "datetime-literal-precision",
					}),
				}),
			]);
			expect(
				atCarrier(carrier, at("2026-01-01T10:00:00.123"), withCaseProperties),
			).toEqual([]);
			expect(
				atCarrier(carrier, at("2026-01-01T10:00"), withCaseProperties),
			).toEqual([]);
		},
	);
});

describe("functions a form can't run", () => {
	it.each(CARRIERS)("refuses here() in a %s", (carrier) => {
		const refused = atCarrier(carrier, {
			kind: "eq",
			left: { kind: "here" },
			right: value("x"),
		});
		expect(refused).toEqual([
			expect.objectContaining({
				code: "XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
				details: expect.objectContaining({ reason: "here" }),
			}),
		]);
		expect(refused[0].message).toContain("uses here(), the worker's location");
	});

	it("offers a location question where a slot reads answers, and the calculated column where it reads none", () => {
		const here: Expression = {
			kind: "eq",
			left: { kind: "here" },
			right: value("x"),
		};
		const inForm = formLogicFindings(
			here,
			requireContext(formFixture(), {
				entity: "field",
				uuid: ids.text,
				slot: "relevant",
			}),
		);
		expect(inForm).toEqual([
			expect.objectContaining({
				details: { reason: "here", hereSurface: "form" },
			}),
		]);
		expect(inForm[0].message).toContain("You can add a location question");
		const inFilter = formLogicFindings(
			here,
			requireContext(formFixture(), {
				entity: "module",
				uuid: ids.module,
				slot: "case_list_filter",
			}),
		);
		expect(inFilter).toEqual([
			expect.objectContaining({
				details: { reason: "here", hereSurface: "record" },
			}),
		]);
		expect(inFilter[0].message).toContain(
			"which only a case list's calculated column can read. You can show it in a calculated column instead.",
		);
	});

	it("names the question whose choice label a formula asks for", () => {
		const label: Expression = {
			kind: "eq",
			left: {
				kind: "choice-name",
				field: ids.choice,
				value: field(ids.choice),
			},
			right: value("Yes"),
		};
		const written = atCarrier("field", label);
		expect(written).toEqual([
			expect.objectContaining({
				code: "XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
				details: expect.objectContaining({
					reason: "choice-name",
					choiceFieldId: "choice",
				}),
			}),
		]);
		const fromCases = atCarrier("field", label, (doc) => {
			const choice = doc.fields[ids.choice];
			if (choice.kind !== "single_select")
				throw new Error("The choice fixture is missing.");
			choice.optionsSource = {
				kind: "cases",
				caseType: "patient",
				labelProperty: "case_name",
			};
		});
		expect(fromCases).toContainEqual(
			expect.objectContaining({
				code: "XPATH_FUNCTION_CONTEXT_UNAVAILABLE",
				details: expect.objectContaining({
					reason: "choice-name-dynamic",
					choiceFieldId: "choice",
				}),
			}),
		);
	});
});
