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
 * - `targeted-connect-deliver-rename`: a menu of two forms, the first
 *   holding a deliver unit and the second, named for the task, the task and
 *   one label with its description. Connect reads a form's deliver unit
 *   before its task and rejects a delivery while the worker's task is
 *   pending, so a form holding both has its own visit rejected
 *   (`form_receiver/processor.py::process_deliver_form`, finding 61), and a
 *   task goes in a form of its own. The edit renames the deliver unit in the
 *   first form and the task in the second. Its control keeps the one form
 *   holding both.
 * - `targeted-connect-learn-rename`: one form holding a learn module and an
 *   assessment scored by an answer.
 * - `targeted-connect-deliver-hyphen-ids` and
 *   `targeted-connect-learn-hyphen-ids`: the same two apps, every id holding
 *   a hyphen (`home-visit`, `follow-up`; `intro-module`, `intro-check`), with
 *   an edit that renames each to another hyphenated id. A Connect block id
 *   follows the question ID grammar, hyphen included, so these show what
 *   HQ's build and the form builder's two saves make of such a block, and a
 *   renamed hyphenated id left behind (proof 5).
 *
 * No id is one of the names Connect's receiver looks for at any depth of a
 * submission (`module`, `assessment`, `deliver`, `task`,
 * `work_area_update`): a Connect block's id is also its wrapper node's name,
 * and the receiver fails on a wrapper so named (finding 60), which Nova's
 * validator refuses.
 *
 * Both declare Android only, D and D′ alike: no Connect worker signs in to
 * Web Apps, so a Connect app runs on Android alone.
 *
 * Fixed values: each form holds what the worker answers (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { NEW_APP_SETTINGS, proseText } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

/** A deliver app named `id`: the deliver unit and task ids D holds, then the ids D′ renames them to. */
function deliverApp(
	id: string,
	ids: readonly [deliverUnit: string, task: string],
	renamed: readonly [deliverUnit: string, task: string],
	rows: readonly string[],
) {
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const task = { name: "Follow up", description: "Return within a week." };
	const make = (deliverUnit: string, taskId: string) =>
		buildDoc({
			appId: id,
			appName: "Home visits",
			connectType: "deliver",
			// A Connect app runs on Android alone.
			appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
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
						{
							uuid: uuid("task-form"),
							name: task.name,
							type: "survey",
							connect: { task: { id: taskId, ...task } },
							fields: [
								f({
									kind: "label",
									uuid: uuid("note"),
									id: "note",
									label: proseText(task.description),
								}),
							],
						},
					],
				},
			],
		});
	return targetedDocument({
		id,
		rows,
		doc: make(...ids),
		edit: make(...renamed),
		expected: {
			intent: [answerHeld("household-held", form, "/data/household", "Okoye")],
		},
	});
}

export function connectDeliverRename() {
	return deliverApp(
		"targeted-connect-deliver-rename",
		["home_visit", "follow_up"],
		["household_visit", "return_visit"],
		["15, Connect ids (Connect's receiver)"],
	);
}

/** The deliver app with ids that hold hyphens, and an edit that renames both. */
export function connectDeliverHyphenIds() {
	return deliverApp(
		"targeted-connect-deliver-hyphen-ids",
		["home-visit", "follow-up"],
		["household-visit", "return-visit"],
		["names, a Connect block ID holding a hyphen"],
	);
}

/** A learn app named `id`: the learn module and assessment ids D holds, then the ids D′ renames them to. */
function learnApp(
	id: string,
	ids: readonly [learnModule: string, assessment: string],
	renamed: readonly [learnModule: string, assessment: string],
	rows: readonly string[],
) {
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const make = (learnModule: string, assessment: string) => {
		const doc = buildDoc({
			appId: id,
			appName: "Hand washing course",
			connectType: "learn",
			// A Connect app runs on Android alone.
			appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
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
			config.assessment.user_score = term(formField(uuid("score")));
		}
		return doc;
	};
	return targetedDocument({
		id,
		rows,
		doc: make(...ids),
		edit: make(...renamed),
		expected: {
			intent: [answerHeld("score-held", form, "/data/score", "8")],
		},
	});
}

export function connectLearnRename() {
	return learnApp(
		"targeted-connect-learn-rename",
		["hand_washing", "hand_washing_quiz"],
		["washing_hands", "washing_hands_quiz"],
		["15, Connect ids (Connect's receiver)"],
	);
}

/** The learn app with ids that hold hyphens, and an edit that renames both. */
export function connectLearnHyphenIds() {
	return learnApp(
		"targeted-connect-learn-hyphen-ids",
		["intro-module", "intro-check"],
		["intro-module-2", "intro-check-2"],
		["names, a Connect block ID holding a hyphen"],
	);
}
