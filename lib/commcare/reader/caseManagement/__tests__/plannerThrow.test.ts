/**
 * The case management settle when Nova's own planner throws over a draft.
 *
 * Contract: where `planFormCaseWire` throws over the document the reader
 * built, the settle of a basic form and of an advanced form each reports the
 * reader's own defect (`emission-threw`, naming the planner) behind one
 * `unrecognized` finding named by the form's actions key, never a finding
 * that names the planner. The plausible failure: a settle that catches the
 * throw and raises `unrecognized` under the planner's name, which shows a
 * person a function of Nova's as if it were a part of their app. The planner
 * is made to throw at the reader's call alone: it throws only over a draft
 * the reader got wrong, which no app's content gives.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedFixture,
	OP,
} from "../../../__tests__/advancedPlacementFixture";
import { exportedBody, inputFor } from "../../__tests__/novaExport";
import { readHqApp } from "./heldReading";

const armed = vi.hoisted(() => ({ value: false }));

vi.mock("../../../casePlacementPlan", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../casePlacementPlan")>();
	return {
		...actual,
		planFormCaseWire: (...args: Parameters<typeof actual.planFormCaseWire>) => {
			if (armed.value)
				throw new Error("The planner was made to throw by this test.");
			return actual.planFormCaseWire(...args);
		},
	};
});

afterEach(() => {
	armed.value = false;
});

/** A reading of `doc`'s export with the planner throwing while the reader runs. */
async function readWithPlannerThrowing(
	doc: Parameters<typeof exportedBody>[0],
) {
	const input = await inputFor(exportedBody(doc));
	armed.value = true;
	try {
		return readHqApp(input);
	} finally {
		armed.value = false;
	}
}

function basicFollowUp() {
	return buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "weight",
								caseWrite: { caseType: "patient", property: "weight" },
							}),
						],
					},
				],
			},
		],
	});
}

describe("a planner that throws over the reader's draft", () => {
	it.each([
		["a basic form", () => basicFollowUp(), "schema:Form.actions"],
		[
			"an advanced form",
			() =>
				advancedFixture({
					formType: "followup",
					menu: "members",
					operations: () => [{ uuid: OP("own"), id: "member", action: "own" }],
				}).doc,
			"schema:AdvancedForm.actions",
		],
	] as const)(
		"is the reader's defect at %s, behind its actions key",
		async (_, doc, key) => {
			const outcome = await readWithPlannerThrowing(doc());
			expect(
				outcome.defects.some(
					(defect) =>
						defect.name === key &&
						defect.why.includes("planFormCaseWire threw"),
				),
			).toBe(true);
			const findings = outcome.kind === "account" ? outcome.findings : [];
			expect(findings.some((one) => one.detail.name === key)).toBe(true);
			expect(findings.map((one) => one.detail.name)).not.toContain(
				"planFormCaseWire",
			);
		},
	);
});
