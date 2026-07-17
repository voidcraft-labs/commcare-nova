/**
 * `summarizeBlueprint` × the unwritten-property reminder: when the app
 * reads case properties no form in it writes, the summary closes with
 * a `<system_reminder>` block stating them as background knowledge —
 * and stays reminder-free otherwise.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { summarizeBlueprint } from "../summarizeBlueprint";

function readingDoc() {
	return buildDoc({
		appName: "Med Tracker",
		caseTypes: [
			{
				name: "medication_order",
				properties: [{ name: "order_status", label: "Order status" }],
			},
		],
		modules: [
			{
				name: "Orders",
				caseType: "medication_order",
				forms: [
					{
						name: "Administer Medication",
						type: "followup",
						fields: [
							f({
								id: "med_given",
								kind: "text",
								relevant: "#medication_order/order_status = 'delivered'",
							}),
						],
					},
				],
			},
		],
	});
}

describe("summarizeBlueprint — unwritten-property reminder", () => {
	it("closes the summary with a system reminder naming the property", () => {
		const summary = summarizeBlueprint(readingDoc());
		expect(summary).toContain("<system_reminder>");
		expect(summary.trimEnd().endsWith("</system_reminder>")).toBe(true);
		expect(summary).toContain("`order_status`");
		expect(summary).toContain("no form in this app writes");
		// Framed as knowledge, not work: it says this is not a problem and
		// tells the SA not to raise it unprompted.
		expect(summary).toContain("This is not a problem");
		expect(summary).toContain("don't bring it up with the user");
		// The reminder is the summary's tail.
		expect(summary.indexOf("<system_reminder>")).toBeGreaterThan(
			summary.indexOf("**Structure:**"),
		);
	});

	it("emits no reminder when every read property has a writer", () => {
		const summary = summarizeBlueprint(
			buildDoc({
				appName: "Clean",
				modules: [
					{
						name: "Survey",
						forms: [
							{
								name: "Feedback",
								type: "survey",
								fields: [f({ id: "comment", kind: "text" })],
							},
						],
					},
				],
			}),
		);
		expect(summary).not.toContain("<system_reminder>");
	});
});
