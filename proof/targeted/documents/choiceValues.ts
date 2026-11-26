/**
 * Choice values holding either or both quote marks, and selects of one choice
 * (`targeted-choice-values`).
 *
 * A stored choice value holds no whitespace. Quoted values appear verbatim
 * as the `<value>` of an `<item>`, as the token a multi-select answer holds, and as
 * the case property a save writes. One registration of a client holds:
 *
 * - a single select and a multi-select of one choice each, which HQ's form
 *   builder and Core both take;
 * - a single select starting at `it's_"here"`, and a multiple select whose
 *   tokens contain apostrophes, double quote marks and both together; each
 *   is saved to a select property of the client;
 * - a display condition on a question for each quoted value, a literal no
 *   reader may split or alter;
 * - a label showing the single select's choice label (`jr:choice-name`),
 *   which keys the label by the value.
 *
 * The clients' case list shows each saved property in a plain column, which
 * HQ's JSON writes with placeholder keys and no value.
 *
 * Fixed values: the form, opened as its menu's registration, holds the
 * single select's mixed-quote answer and all three multi-select values.
 * Core's evaluation takes a select's answer as each
 * chosen choice's 1-based position, as Web Apps sends it
 * (`JsonActionUtils.getAnswerData`), so the requests name `5` and `1 2 3`.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText, type Uuid } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import type { Expectation } from "../expected";
import { answerHeld, type HeldSession } from "./echo";

const ID = "targeted-choice-values";
const uuid = (name: string) => targetedUuid(ID, name);

const MIXED = `it's_"here"`;
const MIXED_XPATH = `concat('it', "'", 's_"here"')`;

const ANSWER_OPTIONS = [
	{ value: "it's", label: "It's here" },
	{ value: 'say"hi"', label: "Say hi" },
	{ value: "back`tick", label: "Backtick" },
	{ value: "plain", label: "Plain" },
	{ value: MIXED, label: "Both quote marks" },
] as const;
const TIME_OPTIONS = [
	{ value: "o'clock", label: "On the hour" },
	{ value: 'half"past', label: "Half past" },
	{ value: MIXED, label: "Scheduled" },
] as const;

const options = (
	name: string,
	values: readonly { value: string; label: string }[],
) =>
	values.map(({ value, label }, index) => ({
		uuid: `targeted:${ID}:${name}-option-${index}`,
		value,
		label,
	}));

/**
 * The select at `path` answered with `chosen`, each named by its 1-based
 * position among `values`, holds the chosen values joined by a space.
 */
function choicesHeld(
	id: string,
	form: Uuid,
	path: string,
	values: readonly { value: string }[],
	chosen: readonly string[],
	session: HeldSession,
): Expectation {
	const positions = chosen.map((value) => {
		const position = values.findIndex((option) => option.value === value);
		if (position < 0) {
			throw new Error(
				`The select at ${path} has no choice ${JSON.stringify(value)}.`,
			);
		}
		return String(position + 1);
	});
	const held = answerHeld(id, form, path, chosen.join(" "), "local", session);
	return {
		...held,
		request: {
			...held.request,
			answers: [{ path, value: positions.join(" ") }],
		},
	};
}

export function choiceValues() {
	const form = uuid("register");
	const doc = buildDoc({
		appId: ID,
		appName: "Choice values",
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{
						name: "answer",
						label: proseText("Answer"),
						data_type: "single_select",
						options: ANSWER_OPTIONS.map(({ value, label }) => ({
							value,
							label: proseText(label),
						})),
					},
					{
						name: "times",
						label: proseText("Times"),
						data_type: "multi_select",
						options: TIME_OPTIONS.map(({ value, label }) => ({
							value,
							label: proseText(label),
						})),
					},
				],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Clients",
				caseType: "client",
				caseListConfig: caseListOf([
					plainColumn(uuid("name-column"), "case_name", "Name"),
					plainColumn(uuid("answer-column"), "answer", "Answer"),
					plainColumn(uuid("times-column"), "times", "Times"),
				]),
				forms: [
					{
						uuid: form,
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("name"),
								id: "name",
								label: proseText("Name"),
								caseWrite: { caseType: "client", property: "case_name" },
							}),
							f({
								kind: "single_select",
								uuid: uuid("consent"),
								id: "consent",
								label: proseText("Consent"),
								options: options("consent", [{ value: "yes", label: "Yes" }]),
							}),
							f({
								kind: "multi_select",
								uuid: uuid("topics"),
								id: "topics",
								label: proseText("Topics"),
								options: options("topics", [
									{ value: "nutrition", label: "Nutrition" },
								]),
							}),
							f({
								kind: "single_select",
								uuid: uuid("answer"),
								id: "answer",
								label: proseText("Answer"),
								options: options("answer", ANSWER_OPTIONS),
								default_value: MIXED_XPATH,
								caseWrite: { caseType: "client", property: "answer" },
							}),
							f({
								kind: "multi_select",
								uuid: uuid("times"),
								id: "times",
								label: proseText("Times"),
								options: options("times", TIME_OPTIONS),
								caseWrite: { caseType: "client", property: "times" },
							}),
							f({
								kind: "text",
								uuid: uuid("its-note"),
								id: "its_note",
								label: proseText("Say more about it"),
								relevant: `#form/answer = "it's"`,
							}),
							f({
								kind: "text",
								uuid: uuid("say-hi-note"),
								id: "say_hi_note",
								label: proseText("Say more about the greeting"),
								relevant: `#form/answer = 'say"hi"'`,
							}),
							f({
								kind: "text",
								uuid: uuid("backtick-note"),
								id: "backtick_note",
								label: proseText("Say more about the backtick"),
								relevant: "#form/answer = 'back`tick'",
							}),
							f({
								kind: "text",
								uuid: uuid("clock-note"),
								id: "clock_note",
								label: proseText("Say more about the hour"),
								relevant: `selected(#form/times, "o'clock")`,
							}),
							f({
								kind: "text",
								uuid: uuid("half-note"),
								id: "half_note",
								label: proseText("Say more about the half hour"),
								relevant: `selected(#form/times, 'half"past')`,
							}),
							f({
								kind: "text",
								uuid: uuid("schedule-note"),
								id: "schedule_note",
								label: proseText("Scheduled visit notes"),
								relevant: `selected(#form/times, ${MIXED_XPATH})`,
							}),
							f({
								kind: "hidden",
								uuid: uuid("answer-label"),
								id: "answer_label",
								calculate: "jr:choice-name(#form/answer, '#form/answer')",
							}),
							f({
								kind: "label",
								uuid: uuid("chosen"),
								id: "chosen",
								label: "You chose {{answer_label}}",
							}),
						],
					},
				],
			},
		],
	});
	// The registration's entry gives the new client's id the datum its case block reads.
	const session: HeldSession = {
		command: "m0-f0",
		data: { case_id_new_client_0: "targeted-new-client" },
	};
	return targetedDocument({
		id: ID,
		rows: ["names, a choice value holding a quote mark, and one choice"],
		doc,
		expected: {
			intent: [
				{
					id: "starting-answer",
					export: "local",
					form,
					request: { session, expressions: ["/data/answer"] },
					expect: [{ pointer: "/values/0/value", value: MIXED }],
				},
				choicesHeld(
					"answer-held",
					form,
					"/data/answer",
					ANSWER_OPTIONS,
					[MIXED],
					session,
				),
				choicesHeld(
					"times-held",
					form,
					"/data/times",
					TIME_OPTIONS,
					["o'clock", 'half"past', MIXED],
					session,
				),
			],
		},
	});
}
