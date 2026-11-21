/**
 * A close form's own close in a block of its own, under a form whose case management the
 * reading refuses.
 *
 * Contract: a form that requires a referral is refused at the form
 * (`forms-and-case-writes/form-requires-referral`), its `requires` and `actions` read past under
 * that one finding (`formType.ts`). The close-only block Nova writes for the form's own close
 * (`nova_condition_close/nova_close`) closes the case the form's case management chooses, so it
 * belongs to that refusal: one cause, one finding.
 *
 * The plausible failure: the block judged as an own close the document does not hold, and
 * refused as a block outside Nova's shape beside the referral's finding.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { eq, formField, literal, or, term } from "@/lib/domain/expression";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "../../index";

const OUTCOME = testUuid("referral-close-outcome");
const answer = term(formField(OUTCOME));

const DOC = buildDoc({
	modules: [
		{
			name: "Households",
			caseType: "household",
			forms: [
				{
					name: "Close household",
					type: "close",
					// HQ's `close_case.condition` holds one equality, so this close takes a block.
					closeCondition: or(
						eq(answer, literal("moved")),
						eq(answer, literal("gone")),
					),
					fields: [
						f({
							kind: "text",
							id: "outcome",
							uuid: OUTCOME,
							label: proseText("Outcome"),
						}),
					],
				},
			],
		},
	],
});

describe("a form's own close under a refused case management", () => {
	it("is the refusal's one finding, with no finding at the block", async () => {
		const plain = exportedBody(DOC);
		const attachments = Object.values(
			plain._attachments as Record<string, string>,
		);
		expect(attachments.some((xml) => xml.includes("<nova_close"))).toBe(true);
		const body = exportedBody(DOC, {
			modules: (modules) => {
				const forms = modules[0]?.forms as Record<string, unknown>[];
				const form = forms[0];
				if (form === undefined) throw new Error("The menu holds the form.");
				form.requires = "referral";
				return modules;
			},
		});
		const outcome = readHqApp(await inputFor(body));
		expect(outcome.defects).toEqual([]);
		expect(
			outcome.kind === "account"
				? outcome.findings.map((one) => [one.code, one.place.kind])
				: [],
		).toEqual([["forms-and-case-writes/form-requires-referral", "form"]]);
	});
});
