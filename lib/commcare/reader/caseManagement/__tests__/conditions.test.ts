import fc from "fast-check";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, Expression, Uuid } from "@/lib/domain";
import { caseSlotFacts, stateCondition } from "@/lib/domain/basicCaseSlots";
import { proseText } from "@/lib/domain/prose";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { conditionFinding, readActionCondition } from "../conditions";
import { docNames, named, readCases, readNames } from "./caseReading";
import { readHqApp } from "./heldReading";

const OUTCOME = testUuid("outcome");
const DONE = testUuid("option-done");
const TAGS = testUuid("tags");
const TAG_A = testUuid("option-a");
const FLAG = testUuid("flag");

const field = (uuid: Uuid): Expression => ({
	kind: "term",
	term: { kind: "field", uuid },
});

/** A close form of one menu whose own close holds `closeCondition`. */
function closeForm(closeCondition: Expression): BlueprintDoc {
	return buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Close",
						type: "close",
						closeCondition,
						fields: [
							f({
								kind: "single_select",
								id: "outcome",
								uuid: OUTCOME,
								optionsSource: {
									kind: "inline",
									options: [
										{ value: "done", label: proseText("Done"), uuid: DONE },
										{
											value: "moved",
											label: proseText("Moved"),
											uuid: testUuid("option-moved"),
										},
									],
								},
							}),
							f({
								kind: "multi_select",
								id: "tags",
								uuid: TAGS,
								optionsSource: {
									kind: "inline",
									options: [
										{ value: "a", label: proseText("A"), uuid: TAG_A },
										{
											value: "b",
											label: proseText("B"),
											uuid: testUuid("option-b"),
										},
									],
								},
							}),
							f({
								kind: "hidden",
								id: "flag",
								uuid: FLAG,
								calculate: {
									kind: "term",
									term: { kind: "literal", value: "x" },
								},
							}),
						],
					},
				],
			},
		],
	});
}

/** Reads `doc`'s close form back, and states the condition the reader read in
 *  `doc`'s own identities, by the production function. */
async function readBack(doc: BlueprintDoc) {
	const reading = await readCases(doc);
	const form = reading.forms[0];
	if (form === undefined) throw new Error("The app holds its close form.");
	const docForm = Object.keys(doc.forms)[0] as Uuid;
	const toDoc = new Map([...docNames(doc)].map(([uuid, name]) => [name, uuid]));
	const read = named(form.form.closeCondition, readNames(form));
	const inDoc = named(read, toDoc) as Expression;
	const stored = (
		JSON.parse(JSON.stringify(reading.ctx.input.source.raw)) as {
			modules: {
				forms: { actions: { close_case: { condition: unknown } } }[];
			}[];
		}
	).modules[0]?.forms[0]?.actions.close_case.condition;
	return { form, inDoc, stored, docForm, reading };
}

describe("a basic action's condition read by the inverse of stateCondition", () => {
	const cases: { name: string; condition: Expression; operator: string }[] = [
		{
			name: "a select equal to one of its choices",
			condition: {
				kind: "eq",
				left: field(OUTCOME),
				right: {
					kind: "term",
					term: { kind: "choice", field: OUTCOME, options: [DONE] },
				},
			},
			operator: "=",
		},
		{
			name: "a multi-select holding one choice",
			condition: {
				kind: "multi-select-contains",
				property: field(TAGS),
				quantifier: "any",
				values: [{ kind: "choice", field: TAGS, options: [TAG_A] }],
			},
			operator: "selected",
		},
		{
			name: "a Hidden Value alone",
			condition: field(FLAG),
			operator: "boolean_true",
		},
		{
			name: "a Hidden Value equal to a literal answer",
			condition: {
				kind: "eq",
				left: field(FLAG),
				right: { kind: "term", term: { kind: "literal", value: "x" } },
			},
			operator: "=",
		},
	];

	for (const { name, condition, operator } of cases)
		it(`reads ${name} and states the stored condition back`, async () => {
			const doc = closeForm(condition);
			const { inDoc, stored, docForm } = await readBack(doc);
			expect(inDoc).toEqual(condition);
			const stated = stateCondition(caseSlotFacts(doc, docForm), inDoc, {
				own: true,
				repeat: undefined,
			});
			expect(stated.reasons).toEqual([]);
			expect(stored).toMatchObject({ type: "if", operator });
			expect(stated.stated?.operator).toBe(operator);
			expect(stated.stated?.answer ?? null).toBe(
				(stored as { answer: string | null }).answer ?? null,
			);
		});

	it("reads boolean_true beside a stored answer whole, as HQ's build reads no answer there", async () => {
		// HQ's own template apps store `answer: "1"` beside `boolean_true`, which
		// `xform.py::XForm.action_relevance` never reads.
		const doc = closeForm(field(FLAG));
		const body = exportedBody(doc, {
			modules: (modules) =>
				produce(modules, (draft) => {
					const condition = (
						draft[0] as {
							forms: {
								actions: { close_case: { condition: Record<string, unknown> } };
							}[];
						}
					).forms[0]?.actions.close_case.condition;
					if (condition !== undefined) condition.answer = "1";
				}),
		});
		const outcome = readHqApp(await inputFor(body));
		expect(
			outcome.kind === "account"
				? outcome.findings.map((one) => [one.code, one.detail])
				: [],
		).toEqual([]);
	});

	it("reads `=` on a choice as the choice, never as a literal the gate refuses as condition-not-a-choice", async () => {
		const doc = closeForm(cases[0]?.condition as Expression);
		const { form } = await readBack(doc);
		const close = form.form.closeCondition as { readonly right?: unknown };
		expect(close.right).toMatchObject({
			kind: "term",
			term: { kind: "choice" },
		});
	});

	it("reads a stored condition naming no question as the finding for that", async () => {
		const doc = closeForm(cases[0]?.condition as Expression);
		const { form } = await readBack(doc);
		expect(
			readActionCondition(
				{ type: "if", question: "/data/gone", answer: "x", operator: "=" },
				{ own: true, repeat: undefined },
				form,
			),
		).toEqual({
			kind: "finding",
			entry:
				"forms-and-case-writes/update-path-naming-no-question-in-the-form-in-an-active-action",
		});
		expect(
			readActionCondition(
				{ type: "never" },
				{ own: true, repeat: undefined },
				form,
			),
		).toEqual({
			kind: "never",
		});
		expect(
			readActionCondition(
				{ type: "always" },
				{ own: true, repeat: undefined },
				form,
			),
		).toEqual({
			kind: "always",
		});
	});

	it("states back every condition formActionCondition can write", async () => {
		const doc = closeForm(cases[0]?.condition as Expression);
		const { form, docForm } = await readBack(doc);
		const facts = caseSlotFacts(doc, docForm);
		const scope = { own: true, repeat: undefined };
		const toDoc = new Map(
			[...docNames(doc)].map(([uuid, name]) => [name, uuid]),
		);
		const ids = new Map(
			[...docNames(doc)].filter(
				([uuid]) => doc.fields[uuid as Uuid] !== undefined,
			),
		);
		const choice = (question: Uuid, option: Uuid): Expression => ({
			kind: "term",
			term: { kind: "choice", field: question, options: [option] },
		});
		const answer = fc.oneof(
			fc.string({ maxLength: 6 }),
			fc.constantFrom("done", "moved", "a", "b", "x"),
		);
		const condition: fc.Arbitrary<Expression> = fc.oneof(
			fc.constantFrom(DONE, testUuid("option-moved")).map((option) => ({
				kind: "eq" as const,
				left: field(OUTCOME),
				right: choice(OUTCOME, option),
			})),
			fc.constantFrom(TAG_A, testUuid("option-b")).map(
				(option): Expression => ({
					kind: "multi-select-contains",
					property: field(TAGS),
					quantifier: "any",
					values: [{ kind: "choice", field: TAGS, options: [option] }],
				}),
			),
			fc.constant(field(FLAG)),
			answer.map((value) => ({
				kind: "eq" as const,
				left: field(FLAG),
				right: {
					kind: "term" as const,
					term: { kind: "literal" as const, value },
				},
			})),
			answer.map((value) => ({
				kind: "eq" as const,
				left: field(OUTCOME),
				right: {
					kind: "term" as const,
					term: { kind: "literal" as const, value },
				},
			})),
		);
		let stateable = 0;
		fc.assert(
			fc.property(condition, (expression) => {
				const stated = stateCondition(facts, expression, scope);
				if (stated.reasons.length > 0 || stated.stated === undefined) return;
				stateable += 1;
				// What casePlacementPlan.ts::formActionCondition writes for it.
				const stored = {
					type: "if",
					question: `/data/${ids.get(stated.stated.question)}`,
					answer: stated.stated.answer ?? null,
					operator: stated.stated.operator,
					doc_type: "FormActionCondition",
				};
				const read = readActionCondition(stored, scope, form);
				expect(read.kind).toBe("if");
				if (read.kind !== "if") return;
				const inDoc = named(
					named(read.expression, readNames(form)),
					toDoc,
				) as Expression;
				expect(stateCondition(facts, inDoc, scope)).toEqual(stated);
			}),
			{ numRuns: 200 },
		);
		expect(stateable).toBeGreaterThan(0);
	});

	it("names each refusal of stateCondition by its row", () => {
		expect(conditionFinding(["condition-question-kind"], true)?.entry).toBe(
			"forms-and-case-writes/a-basic-form-s-own-case-s-close-or-open-condition-on-another",
		);
		expect(conditionFinding(["condition-quote-boundary"], true)?.entry).toBe(
			"forms-and-case-writes/a-basic-form-s-own-case-s-close-or-open-condition-on-another",
		);
		expect(conditionFinding(["condition-question-repeat"], false)?.entry).toBe(
			"forms-and-case-writes/a-subcase-or-advanced-action-condition-on-a-question-the-picker",
		);
		expect(conditionFinding(["condition-not-a-choice"], false)?.entry).toBe(
			"forms-and-case-writes/a-subcase-or-advanced-action-condition-on-a-question-the-picker",
		);
		// The rows in table order: a question the picker does not offer before an apostrophe.
		expect(
			conditionFinding(
				["condition-question-kind", "condition-apostrophe"],
				false,
			)?.entry,
		).toBe(
			"forms-and-case-writes/a-subcase-or-advanced-action-condition-on-a-question-the-picker",
		);
		expect(conditionFinding(["condition-apostrophe"], false)?.entry).toBe(
			"forms-and-case-writes/an-open-close-child-case-or-advanced-action-condition-with",
		);
		expect(conditionFinding(["condition-apostrophe"], true)?.entry).toBe(
			"forms-and-case-writes/an-open-close-child-case-or-advanced-action-condition-with",
		);
		expect(conditionFinding(["condition-shape"], true)).toBeUndefined();
	});
});
