import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { NEW_APP_SETTINGS, proseText } from "@/lib/domain";
import { formField, literal, term } from "@/lib/domain/expression/builders";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const id = "targeted-android-app-answers";
const uuid = (name: string) => targetedUuid(id, name);

export function androidAppAnswers() {
	const doc = buildDoc({
		appId: id,
		appName: "Equipment readings",
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		modules: [
			{
				name: "Readings",
				uuid: uuid("module"),
				forms: [
					{
						name: "Take readings",
						type: "survey",
						uuid: uuid("measure"),
						fields: [
							f({
								kind: "text",
								uuid: uuid("unit"),
								id: "unit",
								label: proseText("Unit"),
								default_value: "'litres'",
							}),
							f({
								kind: "repeat",
								uuid: uuid("visits"),
								id: "visits",
								label: proseText("Reading"),
								repeat_mode: "count_bound",
								repeat_count: "2",
								children: [
									f({
										kind: "text",
										uuid: uuid("meter"),
										id: "meter",
										label: proseText("Open meter"),
										default_value: "'previous'",
										androidApp: {
											kind: "open-app",
											action: "org.example.MEASURE",
											send: [
												{ name: "unit", value: term(literal("imperial")) },
												{ name: "unit", value: term(formField(uuid("unit"))) },
											],
											receive: [
												{ name: "measurement", question: uuid("description") },
												{ name: "correction", question: uuid("description") },
												{ name: "measurement", question: uuid("reading") },
												{ name: "photo", question: uuid("attachment") },
												...[
													"guid",
													"match_guid",
													"match_confidence",
													"match_strength",
													"face_template",
												].map((name) => ({ name, question: uuid(name) })),
												{ name: "RIGHT_THUMB", question: uuid("thumb") },
												{ name: "LEFT_THUMB", question: uuid("other_thumb") },
											],
										},
									}),
									f({
										kind: "int",
										uuid: uuid("verify"),
										id: "verify",
										label: proseText("Verify reading"),
										default_value: "9",
										androidApp: {
											kind: "use-question",
											question: uuid("meter"),
										},
									}),
									f({
										kind: "text",
										uuid: uuid("description"),
										id: "description",
										label: proseText("Written reading"),
										default_value: "'prior'",
									}),
									f({
										kind: "int",
										uuid: uuid("reading"),
										id: "reading",
										label: proseText("Reading"),
										default_value: "5",
									}),
									f({
										kind: "file",
										uuid: uuid("attachment"),
										id: "attachment",
										label: proseText("Reading attachment"),
									}),
									...[
										"guid",
										"match_guid",
										"match_confidence",
										"match_strength",
										"face_template",
										"thumb",
										"other_thumb",
									].map((name) =>
										f({
											kind: "hidden",
											uuid: uuid(name),
											id: name,
											default_value: "'prior'",
										}),
									),
								],
							}),
						],
					},
					{
						name: "Confirm reading",
						type: "survey",
						uuid: uuid("primary"),
						fields: [
							f({
								kind: "text",
								uuid: uuid("confirmed"),
								id: "confirmed",
								label: proseText("Confirm reading"),
								required: "true()",
								androidApp: {
									kind: "open-app",
									action: "org.commcare.respiratory.BREATHCOUNT",
									send: [],
									receive: [],
								},
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		rows: ["questions, Android app questions and results"],
		doc,
		expected: {
			intent: [
				answerHeld(
					"previous-answer-kept",
					uuid("measure"),
					"/data/unit",
					"litres",
				),
			],
		},
	});
}
