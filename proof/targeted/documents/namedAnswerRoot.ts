import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

/** A registration's answers, native case block and completion metadata all live
 * in one named envelope. The session instance continues to use its own names. */
export function namedAnswerRoot() {
	const id = "targeted-named-answer-root";
	const uuid = (key: string) => targetedUuid(id, key);
	const form = uuid("registration");
	const doc = buildDoc({
		appId: id,
		appName: "Household registration",
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: uuid("menu"),
				name: "Households",
				caseType: "household",
				caseListConfig: caseListOf([
					plainColumn(uuid("name-column"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: form,
						name: "Register a household",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("name"),
								id: "name",
								label: proseText("Household name"),
								caseWrite: { caseType: "household", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	doc.forms[form].dataRootName = "survey";
	return targetedDocument({
		id,
		doc,
		rows: ["questions/data-root-element-named-other-than-data"],
		expected: {
			intent: [
				// A registration's session gives the case it creates, as a device's does.
				answerHeld("household-name", form, "/survey/name", "Chen", "local", {
					command: "m0-f0",
					data: { case_id_new_household_0: "new-household" },
				}),
			],
		},
	});
}
