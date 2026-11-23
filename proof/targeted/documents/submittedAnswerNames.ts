import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

function receivingAnswers(android: boolean) {
	const id = android
		? "targeted-receiving-answers-android"
		: "targeted-receiving-answers";
	const uuid = (key: string) => targetedUuid(id, key);
	const form = uuid("form");
	const doc = buildDoc({
		appId: id,
		appName: "Household follow-up",
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
					plainColumn(uuid("column"), "case_name", "Household"),
				]),
				forms: [
					{
						uuid: form,
						name: "Register a household",
						type: "registration",
						fields: [
							f({
								kind: "group",
								id: "visit",
								label: proseText("Visit"),
								children: [
									f({
										kind: "text",
										uuid: uuid("name"),
										id: "case_note",
										label: proseText("Household name"),
										caseWrite: { caseType: "household", property: "case_name" },
									}),
									f({
										kind: "text",
										uuid: uuid("description"),
										id: "script",
										label: proseText("Conversation notes"),
									}),
									f({
										kind: "hidden",
										id: "service_value",
										uuid: uuid("service"),
									}),
									...(android
										? [
												f({
													kind: "text",
													id: "Registration",
													label: proseText("Registration reference"),
												}),
											]
										: []),
								],
							}),
						],
					},
				],
			},
		],
	});
	doc.fields[uuid("name")].lockedInHq = true;
	const hidden = doc.fields[uuid("service")];
	if (hidden.kind !== "hidden")
		throw new Error("Expected the integration value");
	hidden.answerNamespace = "urn:receiving-service:household";
	hidden.lockedInHq = true;
	if (android) doc.appSettings.runsOnlyOn = "android";
	return targetedDocument({
		id,
		doc,
		rows: [
			"questions/question-id-case-registration-script",
			"questions/data-node-xmlns-on-a-hidden-value",
			"questions/vellum-lock-all-locked-question",
		],
		expected: {
			intent: [
				answerHeld(
					"ordinary-answer",
					form,
					"/data/visit/script",
					"Agreed to visit",
					"local",
					{ command: "m0-f0" },
				),
			],
		},
	});
}
export const receivingAnswersOnBoth = () => receivingAnswers(false);
export const receivingAnswersOnAndroid = () => receivingAnswers(true);
