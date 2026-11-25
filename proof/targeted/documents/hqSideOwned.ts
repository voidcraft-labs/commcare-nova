/**
 * What a person changes in HQ of a setting Nova owns, and Nova's next publish
 * over it once the person confirms the discard.
 *
 * `targeted-hq-side-owned` is one survey on an app that is not a Connect
 * app, with automatic location off and no Android apps required. Nova's
 * first publish (A) writes both settings, so its baseline owns them
 * (`lib/commcare/targetOverlay.ts::hqImportApplication`). Over A, a person
 * saves in HQ (`hqSide`, `proof/observe/hqside.py`):
 *
 * - "Auto Capture Location" on, on the settings page
 *   (`views/settings.py::edit_commcare_settings`, through
 *   `views/apps.py::edit_app_attr`), which adds location capture to every
 *   form's meta block (`xform.py::XForm._add_meta_2`);
 * - one required Android app, CommCare Reminders, on the app settings page
 *   (`views/settings.py::edit_commcare_profile`, the profile feature
 *   `dependencies`), which HQ keeps only under App Dependencies, so the
 *   configurations grant it (`APP_DEPENDENCIES`), and which its build writes
 *   as the profile's `<dependencies>` and an app string naming the app.
 *
 * Both are settings Nova writes on every publish, so its next publish reads
 * each as a change made in HQ, stops (`hq_changed`), and goes through only
 * with the person's confirmed discard (`republish: "discards"`), writing
 * Nova's values back: location off, no required apps. Proofs 2 and 3 hold
 * the differences that discard makes, and only them, to its statement
 * (`proof/checks/discards.py`); `proof/checks/test_hq_side.py` holds HQ's
 * own value of each after the republish.
 *
 * Fixed values: the form holds the note the worker enters (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-hq-side-owned";
const uuid = (name: string) => targetedUuid(ID, name);

export function hqSideOwned() {
	const form = uuid("form");
	const doc = buildDoc({
		appId: ID,
		appName: "Clinic visits",
		modules: [
			{
				uuid: uuid("module"),
				name: "Visits",
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: uuid("note"),
								id: "note",
								label: proseText("Note"),
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: [
			"a setting Nova owns, changed in HQ: the next publish asks, and writes Nova's value once confirmed",
		],
		doc,
		expected: {
			intent: [answerHeld("note-held", form, "/data/note", "seen")],
		},
		privileges: ["APP_DEPENDENCIES"],
		hqSide: {
			appAttributes: { auto_gps_capture: true },
			profileFeatures: { dependencies: ["org.commcare.dalvik.reminders"] },
			republish: "discards",
		},
	});
}
