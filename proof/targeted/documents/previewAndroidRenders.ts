/**
 * Preview's three Android readings, which no source reading settles: what
 * Android's own code draws for each is read off a device by the three tests
 * of `proof/android` that name this document, and Preview's rule table
 * (`lib/preview/platform.ts`) holds what they observe.
 *
 * - The survey module "Text": its form "Text" holds a label question
 *   labelled `a`, a newline, then `b ![x](y) <b>c</b>`, which Android's
 *   label renderer (Markwon, `CommCareApplication.java::getMarkwonInstance`)
 *   draws in its own way: what becomes of the single newline, the image and
 *   the raw tag (`test_form_reads.py::test_a_markdown_label_renders_as_markwon_renders_it`,
 *   `labelMarkdown`).
 * - The module "Visits" on the case type `visit`: a custom tile of three
 *   cells whose vertical alignments are `top`, `middle` and `bottom`, which
 *   Nova writes as `start`, `center` and `end` and Android's
 *   `views/EntityViewTile.java::computeGravity` reads by its own names
 *   (`test_case_lists.py::test_a_tile_cell_takes_only_middle_vertical_alignment`,
 *   `tileVerticalAlign`).
 * - In "Visits", the follow-up form "Update visit" writes
 *   `visit.visit_status` from its text question `status`, which starts from
 *   the case's saved value (a primary update, which Core's
 *   `CaseXmlParser.java::loadCase` refuses for a case the phone lacks), and
 *   its entry point `update_visit` opens it on a case id no project space
 *   holds (`test_navigation.py::test_an_entry_point_to_a_case_the_phone_lacks_opens_blank_and_its_completion_is_read`,
 *   `entryPointUnheldCaseSubmit`).
 *
 * The document declares Android only: each reading is Android's, and the
 * Web Apps client never replays it.
 *
 * `status` is a case property CommCare reserves, so the case keeps its
 * status as `visit_status`.
 *
 * Fixed values: the restore holds one visit, Amina's in Riverside, whose
 * status is `open`, the case the tile reading lists; the status answered
 * "seen" is the status the form holds.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	NEW_APP_SETTINGS,
	plainColumn,
	proseText,
	tileCell,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";
import { answerHeld } from "./echo";

const ID = "targeted-preview-android-renders";
const uuid = (name: string) => targetedUuid(ID, name);

/** The label the Markwon reading reads, newline and all. */
export const MARKDOWN_LABEL = "a\nb ![x](y) <b>c</b>";

export function previewAndroidRenders() {
	const updateVisit = uuid("update-visit");
	const doc = buildDoc({
		appId: ID,
		appName: "Android renderings",
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "village", label: proseText("Village"), data_type: "text" },
					{
						name: "visit_status",
						label: proseText("Status"),
						data_type: "text",
					},
				],
			},
		],
		modules: [
			{
				uuid: uuid("text-module"),
				name: "Text",
				forms: [
					{
						uuid: uuid("text-form"),
						name: "Text",
						type: "survey",
						fields: [
							f({
								kind: "label",
								uuid: uuid("markdown-label"),
								id: "markdown_label",
								label: proseText(MARKDOWN_LABEL),
							}),
						],
					},
				],
			},
			{
				uuid: uuid("visits-module"),
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListOf(
					[
						plainColumn(uuid("top"), "case_name", "Name", {
							tile: tileCell(0, 0, 4, 1, { verticalAlign: "top" }),
						}),
						plainColumn(uuid("middle"), "village", "Village", {
							tile: tileCell(4, 0, 4, 1, { verticalAlign: "middle" }),
						}),
						plainColumn(uuid("bottom"), "visit_status", "Status", {
							tile: tileCell(8, 0, 4, 1, { verticalAlign: "bottom" }),
						}),
					],
					{ tile: {} },
				),
				forms: [
					{
						uuid: updateVisit,
						name: "Update visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("status"),
								id: "status",
								label: proseText("Status"),
								default_value: "#visit/visit_status",
								caseWrite: { caseType: "visit", property: "visit_status" },
							}),
						],
					},
				],
			},
		],
	});
	const form = doc.forms[updateVisit];
	if (form === undefined) throw new Error("No form Update visit.");
	form.entryPoint = { uuid: uuid("update-visit-entry"), id: "update_visit" };
	return targetedDocument({
		id: ID,
		rows: [
			"Preview's Android readings: a Markdown label, a tile cell's vertical alignment and an entry point to a case the phone lacks",
		],
		doc,
		files: {
			"restore.xml": restoreXml({
				cases: [
					{
						id: "targeted-visit",
						type: "visit",
						name: "Amina",
						properties: { village: "Riverside", visit_status: "open" },
					},
				],
			}),
		},
		expected: {
			intent: [
				answerHeld(
					"status-held",
					updateVisit,
					"/data/status",
					"seen",
					"local",
					{
						command: "m1-f0",
						caseId: "targeted-visit",
					},
				),
			],
		},
	});
}
