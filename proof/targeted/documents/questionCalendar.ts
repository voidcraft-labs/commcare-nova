import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { NEW_APP_SETTINGS, proseText } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

/** Both Android questions open on the same date. Only one supplies the
 * question's own clear button; clearing it must reach HQ as an empty answer. */
export function questionCalendar() {
	const id = "targeted-question-calendar";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("visit");
	const doc = buildDoc({
		appId: id,
		appName: "Visit calendar",
		appSettings: { ...NEW_APP_SETTINGS },
		modules: [
			{
				uuid: uuid("visits"),
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "survey",
						fields: [
							...(["gregorian", "gregorian-with-clear"] as const).map(
								(calendar, index) => {
									const path = index === 0 ? "scheduled" : "rescheduled";
									return f({
										kind: "date",
										id: path,
										uuid: uuid(path),
										label: proseText(
											index === 0 ? "Scheduled visit" : "Rescheduled visit",
										),
										calendar,
										default_value: "date('2023-09-12')",
									});
								},
							),
							...(
								[
									"ethiopian",
									"nepali",
									"gregorian",
									"gregorian-with-clear",
								] as const
							).map((calendar) => {
								const path = `untouched_${calendar.replaceAll("-", "_")}`;
								return f({
									kind: "date",
									id: path,
									uuid: uuid(path),
									label: proseText(`Suggested ${calendar} date`),
									calendar,
								});
							}),
							f({
								kind: "group",
								uuid: uuid("review"),
								id: "review",
								label: proseText("Review"),
								fieldList: true,
								children: [
									f({
										kind: "label",
										uuid: uuid("ready"),
										id: "ready",
										label: proseText("[Ready](https://example.org)"),
										banner: "good",
									}),
									f({
										kind: "label",
										uuid: uuid("check"),
										id: "check",
										label: proseText("Check"),
										banner: "caution",
									}),
									f({
										kind: "text",
										uuid: uuid("notes"),
										id: "notes",
										label: proseText("Notes"),
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		rows: [
			"a worker can erase the alternate Gregorian calendar's answer using its own clear button",
			"a worker leaves each alternate date untouched, with its platform deciding the submitted day",
			"an Android screen groups short banner labels after formatting them",
		],
		doc,
		expected: {
			intent: [answerHeld("held-date", form, "/data/scheduled", "2023-09-12")],
		},
	});
}
