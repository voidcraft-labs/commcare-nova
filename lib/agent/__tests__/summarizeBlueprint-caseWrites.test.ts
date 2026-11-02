/**
 * `summarizeBlueprint` × the case-write lines: a form's open and close
 * conditions print as the form logic `updateForm` takes, through the
 * printer, and each question names where its answer saves. Documents are
 * built through the fixture builder and admitted by the real gate.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	FOLLOWUP,
	holdPlanned,
	holdVisits,
	moveFixture,
} from "@/lib/doc/__tests__/placementMoveFixture";
import { proseText } from "@/lib/domain/prose";
import { summarizeBlueprint } from "../summarizeBlueprint";
import { expectAdmittedDoc } from "./admittedFixture";

function lifecycleDoc(conditions: { open?: string; close?: string }) {
	return expectAdmittedDoc(
		buildDoc({
			appName: "Loans",
			caseTypes: [
				{
					name: "loan",
					properties: [
						{ name: "amount", label: proseText("Amount") },
						{ name: "outcome", label: proseText("Outcome") },
					],
				},
			],
			modules: [
				{
					name: "Loans",
					caseType: "loan",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Register loan",
							type: "registration",
							...(conditions.open !== undefined && {
								openCondition: conditions.open,
							}),
							fields: [
								f({
									id: "borrower",
									kind: "text",
									label: proseText("Borrower"),
									caseWrite: { caseType: "loan", property: "case_name" },
								}),
								f({
									id: "consent",
									kind: "single_select",
									label: proseText("Consent"),
									options: [
										{ value: "yes", label: "Yes" },
										{ value: "no", label: "No" },
									],
								}),
							],
						},
						{
							name: "Close loan",
							type: "close",
							...(conditions.close !== undefined && {
								closeCondition: conditions.close,
							}),
							fields: [
								f({
									id: "outcome",
									kind: "single_select",
									label: proseText("Outcome"),
									options: [
										{ value: "repaid", label: "Repaid" },
										{ value: "written_off", label: "Written off" },
									],
									caseWrite: { caseType: "loan", property: "outcome" },
								}),
							],
						},
					],
				},
			],
		}),
	);
}

/** The summary lines of the form named `name`, up to the next form. */
function formLines(summary: string, name: string): string[] {
	const lines = summary.split("\n");
	const start = lines.findIndex((line) => line.includes(`Form "${name}"`));
	if (start < 0) throw new Error(`Missing form ${name}.`);
	const end = lines.findIndex(
		(line, index) => index > start && line.includes("- Form "),
	);
	return lines.slice(start, end < 0 ? undefined : end);
}

describe("summarizeBlueprint — case writes", () => {
	it("prints a close form's close condition as form logic", () => {
		const summary = summarizeBlueprint(
			lifecycleDoc({ close: "#form/outcome = 'repaid'" }),
		);
		expect(formLines(summary, "Close loan")).toContain(
			"    close when: #form/outcome = 'repaid'",
		);
	});

	it("prints a registration's open condition as form logic", () => {
		const summary = summarizeBlueprint(
			lifecycleDoc({ open: "#form/consent = 'yes'" }),
		);
		expect(formLines(summary, "Register loan")).toContain(
			"    open when: #form/consent = 'yes'",
		);
	});

	it("prints no condition line for a form without one", () => {
		const summary = summarizeBlueprint(lifecycleDoc({}));
		expect(summary).not.toContain("close when:");
		expect(summary).not.toContain("open when:");
	});

	it("names where each question's answer saves, read off the case changes", () => {
		const summary = summarizeBlueprint(lifecycleDoc({}));
		expect(
			formLines(summary, "Register loan").some(
				(line) =>
					line.includes("- borrower ") && line.endsWith("→ loan.case_name"),
			),
		).toBe(true);
		expect(
			formLines(summary, "Close loan").some(
				(line) =>
					line.includes("- outcome ") && line.endsWith("→ loan.outcome"),
			),
		).toBe(true);
	});
});

describe("summarizeBlueprint — what a published app keeps", () => {
	/** The follow-up visit as a publish recorded it: its own case kept where
	 *  the placement planner put it, and its query repeat's rows set when the
	 *  form opens. */
	function published() {
		// A new document object: the fixture holds placements by changing the
		// document it planned them over, and the plans are memoized per
		// document.
		return expectAdmittedDoc({
			...holdVisits(holdPlanned(moveFixture(), FOLLOWUP), "model-iteration"),
		});
	}

	it("says where a form's held own case is kept", () => {
		const followUp = formLines(
			summarizeBlueprint(published()),
			"Follow-up visit",
		);
		expect(followUp).toContain("    own case kept in case management");
		const unheld = summarizeBlueprint(expectAdmittedDoc(moveFixture()));
		expect(unheld).not.toContain("own case kept in");
	});

	it("marks a held query repeat's rows as kept", () => {
		const visits = (summary: string) =>
			formLines(summary, "Follow-up visit").find((line) =>
				line.includes("- visits "),
			);
		expect(visits(summarizeBlueprint(published()))).toMatch(
			/\[rows set when opened, kept\]$/,
		);
		expect(
			visits(summarizeBlueprint(expectAdmittedDoc(moveFixture()))),
		).toMatch(/\[rows set when opened\]$/);
	});
});
