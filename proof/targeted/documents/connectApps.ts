/**
 * The Connect apps the Connect proof runs (`proof/connect`): a deliver app
 * and a learn app, each with the edit that renames its Connect block ids.
 *
 * Connect keys what it knows of an app by those ids: a learn module, a
 * deliver unit and a task type are rows found by `slug`
 * (`commcare-connect opportunity/tasks.py::sync_learn_modules_and_deliver_units`,
 * `form_receiver/processor.py::get_or_create_deliver_unit`,
 * `get_or_create_learn_module`, `process_task_modules`). So D is the app an
 * opportunity is made over, and D′ is what a rename of its ids leaves on the
 * wire (defect 15's migration renames ids its narrowed rule refuses), as
 * Nova's own publish of the edit and Nova's own local archive of it.
 *
 * - `targeted-connect-deliver-rename`: one form holding a deliver unit and a
 *   task. Its ids are none of the names Connect's receiver looks for at any
 *   depth of a submission (`module`, `assessment`, `deliver`, `task`,
 *   `work_area_update`): a Connect block's id is also its wrapper node's
 *   name, and the receiver fails on a wrapper so named (the harness's
 *   finding 60, which `connect-deliver-default`'s task shows).
 * - `targeted-connect-learn-rename`: one form holding a learn module and an
 *   assessment scored by an answer.
 *
 * - `targeted-connect-learn-key-names` and
 *   `targeted-connect-deliver-key-names`: one form for each remaining name
 *   of finding 60 (`module` and `assessment` in a learn app; `deliver` and
 *   `work_area_update` in a deliver app).
 *
 * Fixed values: each form holds what the worker answers (`./echo.ts`).
 */

import { buildDoc, f, xpIn } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

export function connectDeliverRename() {
	const id = "targeted-connect-deliver-rename";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const make = (deliverUnit: string, task: string) =>
		buildDoc({
			appId: id,
			appName: "Home visits",
			connectType: "deliver",
			modules: [
				{
					uuid: uuid("module"),
					name: "Visits",
					forms: [
						{
							uuid: form,
							name: "Home visit",
							type: "survey",
							connect: {
								deliver_unit: { id: deliverUnit, name: "Home visit" },
								task: {
									id: task,
									name: "Follow up",
									description: "Return within a week.",
								},
							},
							fields: [
								f({
									kind: "text",
									uuid: uuid("household"),
									id: "household",
									label: proseText("Household"),
								}),
							],
						},
					],
				},
			],
		});
	return targetedDocument({
		id,
		rows: ["15, Connect ids (Connect's receiver)"],
		doc: make("home_visit", "follow_up"),
		edit: make("household_visit", "return_visit"),
		expected: {
			intent: [answerHeld("household-held", form, "/data/household", "Okoye")],
		},
	});
}

export function connectLearnRename() {
	const id = "targeted-connect-learn-rename";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const make = (learnModule: string, assessment: string) => {
		const doc = buildDoc({
			appId: id,
			appName: "Hand washing course",
			connectType: "learn",
			modules: [
				{
					uuid: uuid("module"),
					name: "Course",
					forms: [
						{
							uuid: form,
							name: "Hand washing",
							type: "survey",
							connect: {
								learn_module: {
									id: learnModule,
									name: "Hand washing",
									description: "Wash for twenty seconds.",
									time_estimate: 5,
								},
								assessment: { id: assessment },
							},
							fields: [
								f({
									kind: "int",
									uuid: uuid("score"),
									id: "score",
									label: proseText("Score"),
								}),
							],
						},
					],
				},
			],
		});
		const config = doc.forms[form].connect;
		if (config && "assessment" in config && config.assessment) {
			config.assessment.user_score = xpIn(doc, form, "#form/score");
		}
		return doc;
	};
	return targetedDocument({
		id,
		rows: ["15, Connect ids (Connect's receiver)"],
		doc: make("hand_washing", "hand_washing_quiz"),
		edit: make("washing_hands", "washing_hands_quiz"),
		expected: {
			intent: [answerHeld("score-held", form, "/data/score", "8")],
		},
	});
}

/**
 * A Connect app whose blocks are each named like one of the keys Connect's
 * receiver looks for in that kind of app, one block to a form, so each
 * form's submission shows what the receiver makes of one name (the
 * harness's finding 60).
 */
function keyNamedForms(
	id: string,
	connectType: "learn" | "deliver",
	names: readonly string[],
) {
	const uuid = (name: string) => targetedUuid(id, name);
	const forms = names.map((name) => uuid(`form-${name}`));
	const doc = buildDoc({
		appId: id,
		appName: connectType === "learn" ? "Key names course" : "Key names visits",
		connectType,
		modules: [
			{
				uuid: uuid("module"),
				name: "Work",
				forms: names.map((name, index) => ({
					uuid: forms[index],
					name: `Form ${index + 1}`,
					type: "survey" as const,
					connect:
						connectType === "deliver"
							? { deliver_unit: { id: name, name: `Unit ${index + 1}` } }
							: name === "assessment"
								? { assessment: { id: name } }
								: {
										learn_module: {
											id: name,
											name: `Lesson ${index + 1}`,
											description: "One lesson.",
											time_estimate: 5,
										},
									},
					fields: [
						f({
							kind: "int",
							uuid: uuid(`score-${name}`),
							id: "score",
							label: proseText("Score"),
						}),
					],
				})),
			},
		],
	});
	return targetedDocument({
		id,
		rows: ["60, a Connect block named like one of Connect's keys"],
		doc,
		expected: {
			intent: forms.map((form, index) =>
				answerHeld(`score-held-${index + 1}`, form, "/data/score", "8"),
			),
		},
	});
}

export function connectLearnKeyNames() {
	return keyNamedForms("targeted-connect-learn-key-names", "learn", [
		"module",
		"assessment",
	]);
}

export function connectDeliverKeyNames() {
	return keyNamedForms("targeted-connect-deliver-key-names", "deliver", [
		"deliver",
		"work_area_update",
	]);
}
