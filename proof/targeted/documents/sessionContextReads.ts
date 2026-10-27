/**
 * The session context read where CommCare supplies it
 * (`targeted-session-context-reads`), declared Web Apps only, since Android
 * has no window width.
 *
 * Module "Patients" shows only when the window width is above 0 (a module
 * display condition, a slot CommCare evaluates while the menu loads, where
 * Formplayer's walk and the client send a width), shows the width, the clock
 * drift and the app language in calculated columns, and starts its Search
 * field `width` from the window width, a search value the device works out.
 * Its follow-up form "Visit" writes a note and reads the drift, the language,
 * the app version and the device id in hidden values; a form reads no window
 * width, which a later answer's request does not carry.
 *
 * Fixed values: the note answered "seen" is the note the form holds. The
 * context values are each runtime's own (Web Apps' drift is 0, the
 * session's language, the client's window width), so the readers' records
 * hold them and proofs 3 and 4 compare them across states. The app version
 * and device id Formplayer gives are pin facts Preview states for Web Apps
 * (`lib/preview/platform.ts`), so `formplayer-session.json` holds them and
 * the intent check holds each Formplayer submission of the form to them
 * (`proof/checks/intent.py::formplayer_session_values`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	calculatedColumn,
	NEW_APP_SETTINGS,
	plainColumn,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	concat,
	gt,
	literal,
	sessionContext,
	term,
} from "@/lib/domain/expression";
import {
	WEB_APPS_APPVERSION,
	WEB_APPS_DEVICE_ID,
} from "@/lib/preview/platform";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-session-context-reads";
const uuid = (name: string) => targetedUuid(ID, name);

export function sessionContextReads() {
	const visit = uuid("visit");
	const hidden = (id: string, field: Parameters<typeof sessionContext>[0]) =>
		f({
			kind: "hidden",
			uuid: uuid(id),
			id,
			calculate: term(sessionContext(field)),
		});
	const doc = buildDoc({
		appId: ID,
		appName: "Session context",
		// Android has no window width.
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "note", label: proseText("Note"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Patients",
				caseType: "patient",
				displayCondition: gt(
					term(sessionContext("window_width")),
					term(literal(0)),
				),
				caseListConfig: caseListOf(
					[
						plainColumn(uuid("name-column"), "case_name", "Name"),
						calculatedColumn(
							uuid("window-column"),
							"Window",
							term(sessionContext("window_width")),
						),
						calculatedColumn(
							uuid("drift-column"),
							"Drift",
							term(sessionContext("drift")),
						),
						calculatedColumn(
							uuid("language-column"),
							"Language",
							term(sessionContext("applanguage")),
						),
					],
					{
						searchInputs: [
							simpleSearchInputDef(
								uuid("width-input"),
								"width",
								"Window width",
								"text",
								"note",
								// A text field starts from text: the whole number the
								// width types as, joined into one.
								{ default: concat(term(sessionContext("window_width"))) },
							),
						],
					},
				),
				forms: [
					{
						uuid: visit,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("note"),
								id: "note",
								label: proseText("Note"),
								caseWrite: { caseType: "patient", property: "note" },
							}),
							hidden("drift", "drift"),
							hidden("language", "applanguage"),
							hidden("app_version", "appversion"),
							hidden("device_id", "deviceid"),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: [
			"the session context read in record slots, a search value and form logic",
		],
		doc,
		expected: {
			intent: [
				answerHeld("note-held", visit, "/data/note", "seen", "A", {
					command: "m0-f0",
					caseId: "targeted-patient",
				}),
			],
		},
		files: {
			"formplayer-session.json": `${JSON.stringify({
				"/data/app_version": WEB_APPS_APPVERSION,
				"/data/device_id": WEB_APPS_DEVICE_ID,
			})}\n`,
		},
	});
}
