import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const id = "targeted-web-form-activity";
const uuid = (name: string) => targetedUuid(id, name);

export function webFormActivity() {
	const form = uuid("form");
	const key = uuid("key");
	const title = uuid("title");
	const window = uuid("window");
	const value = uuid("record");
	const doc = buildDoc({
		appId: id,
		appName: "Clinic activity",
		modules: [
			{
				uuid: uuid("menu"),
				name: "Clinics",
				forms: [
					{
						uuid: form,
						name: "Report a visit",
						type: "survey",
						fields: [
							f({
								kind: "hidden",
								uuid: value,
								id: "record",
								calculate: "'Northern clinic'",
							}),
							f({
								kind: "text",
								uuid: key,
								id: "visit_key",
								label: {
									parts: [
										{ kind: "text", text: "Visit " },
										{ kind: "field-ref", uuid: value },
									],
								},
							}),
							f({
								kind: "text",
								uuid: title,
								id: "visit_title",
								label: {
									parts: [{ kind: "field-ref", uuid: value }],
								},
							}),
							f({
								kind: "text",
								uuid: window,
								id: "activity_window",
								label: "90",
							}),
						],
					},
				],
			},
		],
	});
	doc.forms[form] = {
		...doc.forms[form],
		activityKeyText: { carrier: { field: key, role: "field-label" } },
		activityTitleText: { carrier: { field: title, role: "field-label" } },
		activityWindowText: { carrier: { field: window, role: "field-label" } },
	};
	return targetedDocument({
		id,
		doc,
		rows: [
			"Web Apps activity notice uses initialized field values and the worker's restore",
		],
		expected: {
			intent: [
				answerHeld(
					"activity-initial-record",
					form,
					"/data/record",
					"Northern clinic",
				),
			],
		},
	});
}
