/**
 * `summarizeBlueprint` × the unwritten-property reminder: when the app
 * reads case properties no form in it writes, the summary closes with
 * a `<system_reminder>` block stating them as background knowledge —
 * and stays reminder-free otherwise.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
import { summarizeBlueprint } from "../summarizeBlueprint";
import { expectAdmittedDoc } from "./admittedFixture";

function readingDoc(write = false) {
	return expectAdmittedDoc(
		buildDoc({
			appName: "Med Tracker",
			caseTypes: [
				{
					name: "medication_order",
					properties: [
						{ name: "order_status", label: proseText("Order status") },
					],
				},
			],
			modules: [
				{
					name: "Orders",
					caseType: "medication_order",
					caseListConfig: caseListConfig([
						{ field: "order_status", header: "Order status" },
					]),
					forms: [
						{
							name: "Administer Medication",
							type: "followup",
							fields: [
								f({
									id: "med_given",
									kind: "text",
									relevant: "#medication_order/order_status = 'delivered'",
									...(write && {
										caseWrite: {
											caseType: "medication_order",
											property: "order_status",
										},
									}),
								}),
							],
						},
					],
				},
			],
		}),
	);
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

	it("emits no reminder when the previously unwritten property has an actual form-field writer", () => {
		const summary = summarizeBlueprint(readingDoc(true));
		expect(summary).not.toContain("<system_reminder>");
	});
});
