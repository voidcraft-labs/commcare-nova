/**
 * A child case's condition that reads one question alone, `boolean_true`,
 * read as the commit gate judges it. Contract: where the question is a Hidden
 * Value a condition calculates, CommCare holds a yes or no and the reading
 * holds the read with no finding; where it is a question whose answer is no
 * yes or no (a select here), the reading raises the condition's own entry
 * rather than holding a document the gate refuses (`heldReading.ts` fails a
 * reading the gate refuses with no finding). The plausible failure: the
 * reader admitting what the gate refuses, which stopped CommCare HQ's WASH
 * starter app at the gate, or refusing the yes or no it can hold.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "./heldReading";

const FORM = testUuid("not-yes-no-form");
const FLAG = testUuid("not-yes-no-flag");
const REFERRAL = testUuid("not-yes-no-referral");
const NAME = testUuid("not-yes-no-name");

function inspection(): BlueprintDoc {
	const built = buildDoc({
		caseTypes: [
			{ name: "household", properties: [] },
			{ name: "referral", parent_type: "household", properties: [] },
		],
		modules: [
			{
				name: "Households",
				caseType: "household",
				forms: [
					{
						uuid: FORM,
						name: "Inspection",
						type: "followup",
						fields: [
							f({
								uuid: NAME,
								kind: "text",
								id: "referral_name",
								label: "Name",
							}),
							f({
								kind: "single_select",
								id: "outcome",
								label: "Outcome",
								optionsSource: {
									kind: "inline",
									options: [
										{
											value: "1",
											label: proseText("Yes"),
											uuid: testUuid("not-yes-no-yes"),
										},
										{
											value: "0",
											label: proseText("No"),
											uuid: testUuid("not-yes-no-no"),
										},
									],
								},
							}),
							f({
								uuid: FLAG,
								kind: "hidden",
								id: "create_referral",
								calculate: "#form/outcome = '1'",
							}),
						],
					},
				],
			},
			{
				// A basic child case's type is a menu's case type.
				name: "Referrals",
				caseType: "referral",
				forms: [
					{
						name: "Follow up",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
	const form = built.forms[FORM];
	return {
		...built,
		forms: {
			...built.forms,
			[FORM]: {
				...form,
				caseOperations: [
					...(form.caseOperations ?? []),
					{
						uuid: REFERRAL,
						id: "referral",
						action: "create",
						caseType: "referral",
						target: { kind: "new" },
						name: term(formField(NAME)),
						links: [
							{
								identifier: "parent",
								targetType: "household",
								relationship: "child",
								target: { kind: "session" },
							},
						],
						condition: term(formField(FLAG)),
					},
				],
			},
		},
	};
}

type Modules = {
	forms: { actions: { subcases: { condition: Record<string, unknown> }[] } }[];
}[];

/** The findings a reading of `doc`'s export makes, its child case's condition
 *  pointed at `question` when one is named. */
async function findings(question?: string): Promise<readonly string[]> {
	const doc = inspection();
	const body = exportedBody(doc, {
		modules: (modules) =>
			produce(modules, (draft) => {
				const condition = (draft as unknown as Modules)[0]?.forms[0]?.actions
					.subcases[0]?.condition;
				if (condition === undefined)
					throw new Error("The form keeps its child case in a basic slot.");
				expect(condition).toMatchObject({ operator: "boolean_true" });
				if (question !== undefined) condition.question = question;
			}),
	});
	const outcome = readHqApp(await inputFor(body));
	return outcome.kind === "account"
		? outcome.findings.map((one) => one.code)
		: [];
}

describe("a child case's condition reading one question alone", () => {
	it("holds a Hidden Value a condition calculates", async () => {
		expect(await findings()).toEqual([]);
	});

	it("raises its own entry over a choice question, whose answer no yes or no holds", async () => {
		expect(await findings("/data/outcome")).toEqual([
			"forms-and-case-writes/a-child-case-or-advanced-action-condition-boolean-true-on-a",
		]);
	});
});
