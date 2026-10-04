/**
 * Defect 6, Core: a form condition that orders two times.
 *
 * Nova admits an ordering comparison on time values in form logic, and Core
 * compares both sides of an ordering as numbers, where a time's text holds `:`
 * and so reads as NaN (`commcare-core javarosa xpath/expr/FunctionUtils.java::toNumeric`),
 * so every such comparison is false on the device.
 *
 * Fixed values: the visit starts at 14:30 and ends at 15:00, so the start is
 * before the end, and the form's hidden value says so.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";

const ID = "targeted-time-ordering";
const uuid = (name: string) => targetedUuid(ID, name);

export function timeOrdering() {
	const form = uuid("form");
	const doc = buildDoc({
		appId: ID,
		appName: "Visit times",
		modules: [
			{
				uuid: uuid("module"),
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Visit times",
						type: "survey",
						fields: [
							f({
								kind: "time",
								uuid: uuid("start"),
								id: "start",
								label: proseText("Start"),
							}),
							f({
								kind: "time",
								uuid: uuid("end"),
								id: "end",
								label: proseText("End"),
							}),
							f({
								kind: "hidden",
								uuid: uuid("order"),
								id: "order",
								calculate:
									"if(#form/start < #form/end, 'start before end', 'start not before end')",
							}),
							f({
								kind: "label",
								uuid: uuid("late"),
								id: "late",
								label: proseText("The visit ended before it started."),
								relevant: "#form/end < #form/start",
							}),
						],
					},
				],
			},
		],
	});
	const request = {
		answers: [
			{ path: "/data/start", value: "14:30:00" },
			{ path: "/data/end", value: "15:00:00" },
		],
		expressions: ["/data/order"],
	};
	const expectation = (exportName: "local" | "A") => ({
		id: `start-before-end-${exportName === "local" ? "local" : "a"}`,
		export: exportName,
		form,
		request,
		expect: [
			{ pointer: "/answers/0/result", value: "ok" },
			{ pointer: "/answers/1/result", value: "ok" },
			{ pointer: "/values/0/value", value: "start before end" },
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["6, Core"],
		doc,
		expected: { intent: [expectation("local"), expectation("A")] },
	});
}
