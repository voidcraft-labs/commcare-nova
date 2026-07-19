/**
 * `getField` × the unwritten-property reminder: a returned field (or
 * container subtree) that reads a case property no form in the app
 * writes carries a `system_reminder` beside the field payload —
 * background knowledge for the agent, absent otherwise.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { ToolExecutionContext } from "../../toolExecutionContext";
import { getFieldTool } from "../getField";

const CTX = {} as ToolExecutionContext;

const ORDER_CATALOG = [
	{
		name: "medication_order",
		properties: [{ name: "order_status", label: "Order status" }],
	},
];

function docWith(fields: ReturnType<typeof f>[]) {
	return buildDoc({
		caseTypes: ORDER_CATALOG,
		modules: [
			{
				name: "Orders",
				caseType: "medication_order",
				forms: [{ name: "Administer Medication", type: "followup", fields }],
			},
		],
	});
}

async function getField(doc: ReturnType<typeof buildDoc>, fieldId: string) {
	const outcome = await getFieldTool.execute(
		{ moduleIndex: 0, formIndex: 0, fieldId },
		CTX,
		doc,
	);
	expect(outcome.kind).toBe("read");
	return outcome.data;
}

describe("getField — unwritten-property reminder", () => {
	it("carries the reminder when the field reads an unwritten property", async () => {
		const doc = docWith([
			f({
				id: "med_given",
				kind: "text",
				relevant: "#medication_order/order_status = 'delivered'",
			}),
		]);
		const data = await getField(doc, "med_given");
		if ("error" in data) throw new Error(data.error);
		expect(data.system_reminder).toContain("<system_reminder>");
		expect(data.system_reminder).toContain("`order_status`");
		expect(data.system_reminder).toContain("no form in this app writes");
		expect(data.system_reminder).toContain("This is not a problem");
	});

	it("covers reads anywhere in a returned container subtree", async () => {
		const doc = docWith([
			f({
				id: "admin",
				kind: "group",
				label: "Administration",
				children: [
					f({
						id: "med_given",
						kind: "text",
						relevant: "#medication_order/order_status = 'delivered'",
					}),
				],
			}),
		]);
		const data = await getField(doc, "admin");
		if ("error" in data) throw new Error(data.error);
		expect(data.system_reminder).toContain("`order_status`");
	});

	it("omits the key entirely when the property has a writer", async () => {
		const doc = docWith([
			f({
				id: "med_given",
				kind: "text",
				relevant: "#medication_order/order_status = 'delivered'",
			}),
			f({
				id: "order_status",
				kind: "text",
				case_property_on: "medication_order",
			}),
		]);
		const data = await getField(doc, "med_given");
		if ("error" in data) throw new Error(data.error);
		expect("system_reminder" in data).toBe(false);
	});

	it("omits the key on a field with no unwritten reads", async () => {
		const doc = docWith([
			f({ id: "note", kind: "text" }),
			f({
				id: "med_given",
				kind: "text",
				relevant: "#medication_order/order_status = 'delivered'",
			}),
		]);
		const data = await getField(doc, "note");
		if ("error" in data) throw new Error(data.error);
		expect("system_reminder" in data).toBe(false);
	});
});
