/**
 * `summarizeBlueprint` × the no-writer advisories: open advisories
 * close the summary (a fresh-session SA inherits them without the user
 * re-hitting the wall), and an external-marked property carries its
 * marking + note inline in the case-types listing (so the SA never
 * re-asks who writes it).
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { CaseProperty } from "@/lib/domain";
import { summarizeBlueprint } from "../summarizeBlueprint";

function gatedDoc(orderStatus?: Partial<CaseProperty>) {
	return buildDoc({
		appName: "Med Tracker",
		caseTypes: [
			{
				name: "medication_order",
				properties: [
					{ name: "order_status", label: "Order status", ...orderStatus },
				],
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

describe("summarizeBlueprint — workflow advisories", () => {
	it("closes the summary with open advisories", () => {
		const summary = summarizeBlueprint(gatedDoc());
		expect(summary).toContain("**Workflow advisories");
		expect(summary).toContain("`order_status`");
		expect(summary).toContain("no form in this app writes it");
		// The section is the summary's tail.
		expect(summary.indexOf("**Workflow advisories")).toBeGreaterThan(
			summary.indexOf("**Structure:**"),
		);
	});

	it("shows the external marking (with note) inline and drops the advisory", () => {
		const summary = summarizeBlueprint(
			gatedDoc({ external: { note: "set by the pharmacy app" } }),
		);
		expect(summary).toContain(
			"order_status [external: set by the pharmacy app]",
		);
		expect(summary).not.toContain("**Workflow advisories");
	});

	it("emits neither the section nor the marking on a clean app", () => {
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
		expect(summary).not.toContain("Workflow advisories");
		expect(summary).not.toContain("[external");
	});
});
