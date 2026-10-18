import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import type { ExpressionContext } from "../context";
import { slotContext } from "../context";
import type { SlotContextRef } from "../types";

export const ids = Object.fromEntries(
	[
		"module",
		"form",
		"target",
		"link",
		"text",
		"number",
		"time",
		"date",
		"hidden",
		"choice",
		"option",
		"repeat",
		"inside",
	].map((name) => [name, testUuid(`expression-form-${name}`)]),
) as Record<
	| "module"
	| "form"
	| "target"
	| "link"
	| "text"
	| "number"
	| "time"
	| "date"
	| "hidden"
	| "choice"
	| "option"
	| "repeat"
	| "inside",
	ReturnType<typeof testUuid>
>;
export function formFixture(): BlueprintDoc {
	return buildDoc({
		appName: "Expressions",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "appointment", label: "Appointment", data_type: "time" },
				],
			},
		],
		modules: [
			{
				uuid: ids.module,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: ids.form,
						name: "Visit",
						type: "followup",
						formLinks: [
							{
								uuid: ids.link,
								target: {
									type: "form",
									moduleUuid: ids.module,
									formUuid: ids.target,
								},
							},
						],
						fields: [
							f({ uuid: ids.text, id: "text", kind: "text", label: "Text" }),
							f({
								uuid: ids.number,
								id: "number",
								kind: "int",
								label: "Number",
							}),
							f({ uuid: ids.time, id: "time", kind: "time", label: "Time" }),
							f({ uuid: ids.date, id: "date", kind: "date", label: "Date" }),
							f({
								uuid: ids.hidden,
								id: "hidden",
								kind: "hidden",
								calculate: "1",
							}),
							f({
								uuid: ids.choice,
								id: "choice",
								kind: "single_select",
								label: "Choice",
								options: [
									{ uuid: ids.option, value: "yes", label: "Yes" },
									{
										uuid: testUuid("expression-form-option-no"),
										value: "no",
										label: "No",
									},
								],
							}),
							f({
								uuid: ids.repeat,
								id: "rows",
								kind: "repeat",
								children: [
									f({
										uuid: ids.inside,
										id: "inside",
										kind: "text",
										label: "Inside",
									}),
								],
							}),
						],
					},
					{
						uuid: ids.target,
						name: "Next visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
}
export function requireContext(
	doc: BlueprintDoc,
	slot: SlotContextRef,
): ExpressionContext {
	const ctx = slotContext(doc, slot, new Map());
	if (ctx === undefined)
		throw new Error(`The fixture has no owning slot: ${JSON.stringify(slot)}`);
	return ctx;
}
