// Choice values holding one kind of quote mark, and a select with one
// choice, run in Preview's form engine as on a device. The plausible
// failure is Preview and the device disagreeing on a quoted token: a rule
// naming `it's` printed without its literal, a multi-select answer split on
// the quote, or a one-choice select refusing its own answer.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain";
import { eq, formField } from "@/lib/domain/expression";
import type { Choice } from "@/lib/domain/expression/types";
import { buildEngineInput } from "../engineInput";
import { FormEngine } from "../formEngine";

const FORM = testUuid("choice-values-form");
const ANSWER = testUuid("choice-values-answer");
const ITS = testUuid("choice-values-its");
const SAY_HI = testUuid("choice-values-say-hi");
const BACKTICK = testUuid("choice-values-backtick");
const PLAIN = testUuid("choice-values-plain");

const QUOTED_VALUES = [
	{ uuid: ITS, value: "it's", label: proseText("It's") },
	{ uuid: SAY_HI, value: 'say"hi"', label: proseText("Say hi") },
	{ uuid: BACKTICK, value: "back`tick", label: proseText("Backtick") },
	{ uuid: PLAIN, value: "plain", label: proseText("Plain") },
];

const itsChoice: Choice = { kind: "choice", field: ANSWER, options: [ITS] };

function engine(): FormEngine {
	const doc = buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						uuid: FORM,
						name: "Choice values",
						type: "survey",
						fields: [
							f({
								uuid: ANSWER,
								kind: "single_select",
								id: "answer",
								label: proseText("Answer"),
								optionsSource: { kind: "inline", options: QUOTED_VALUES },
							}),
							f({
								kind: "text",
								id: "follow_up",
								label: proseText("Tell us more"),
								relevant: eq(formField(ANSWER), itsChoice),
							}),
							f({
								kind: "multi_select",
								id: "many",
								label: proseText("Many"),
								optionsSource: {
									kind: "inline",
									options: [
										{
											uuid: testUuid("choice-values-many-its"),
											value: "it's",
											label: proseText("It's"),
										},
										{
											uuid: testUuid("choice-values-many-say-hi"),
											value: 'say"hi"',
											label: proseText("Say hi"),
										},
									],
								},
							}),
							f({
								kind: "single_select",
								id: "read_aloud",
								label: proseText("I have read this to the client"),
								optionsSource: {
									kind: "inline",
									options: [
										{
											uuid: testUuid("choice-values-read"),
											value: "read",
											label: proseText("Read"),
										},
									],
								},
							}),
						],
					},
				],
			},
		],
	});
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const input = buildEngineInput(doc, FORM, null);
	if (!input) throw new Error("The form has no engine input.");
	return new FormEngine(input);
}

describe("quoted choice values and a one-choice select in Preview", () => {
	it("shows the follow-up only when the answer is it's", () => {
		const form = engine();
		expect(form.getState("/data/follow_up").visible).toBe(false);
		form.setValue("/data/answer", "it's");
		expect(form.getState("/data/answer").value).toBe("it's");
		expect(form.getState("/data/follow_up").visible).toBe(true);
		form.setValue("/data/answer", 'say"hi"');
		expect(form.getState("/data/follow_up").visible).toBe(false);
	});

	it("keeps both quoted tokens of a multi-select answer", () => {
		const form = engine();
		form.setValue("/data/many", `it's say"hi"`);
		expect(form.getState("/data/many").value.split(" ")).toEqual([
			"it's",
			'say"hi"',
		]);
	});

	it("takes and clears the answer of a select with one choice", () => {
		const form = engine();
		form.setValue("/data/read_aloud", "read");
		expect(form.getState("/data/read_aloud").value).toBe("read");
		form.setValue("/data/read_aloud", "");
		expect(form.getState("/data/read_aloud").value).toBe("");
		expect(form.validateAll()).toBe(true);
	});
});
