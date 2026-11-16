/**
 * `targeted-missing-media`: what each runtime draws for a media reference
 * with no file, on every slot a worker can meet one on. An app brought in
 * from CommCare HQ can hold such references, and Nova decides where one is
 * inert and where it is refused by what each runtime draws for it.
 *
 * The document names one picture, one sound and one more picture on the
 * slots below, and Nova publishes each with its file. The readers' tests
 * (`proof/android/test_missing_media.py`, `proof/webapps/test_missing_media.py`)
 * then take the files away over a fork of the published app
 * (`proof/formplayer/apps.py::with_missing_media`): seven references lose
 * their entry in the app's multimedia map, and the eighth keeps its entry
 * while its file is deleted from the project space.
 *
 * With no entry: the survey "Visit"'s question `remarks`'s image and sound,
 * the sound of its select `answer`'s first choice, its menu's icon and its
 * form's sound, the image column of the case list "Patients" (the statuses
 * "active" and "closed" map to the one picture, and a case holding any other
 * status maps to none, which is the counterpart: the same cell with nothing
 * to draw), and that list's Register action's icon. With an entry and no file: the image of the question
 * `photo`.
 *
 * Fixed values: the survey holds the answer a worker gives `remarks`.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import {
	imageMapColumn,
	imageMapEntry,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { uploadedMedia } from "../../corpus/documents";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

export function missingMedia() {
	const id = "targeted-missing-media";
	const uuid = (name: string) => targetedUuid(id, name);
	const visit = uuid("visit");
	const register = uuid("register");
	const doc = buildDoc({
		appId: id,
		appName: "Missing media",
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "care_status", label: proseText("Status") },
				],
			},
		],
		modules: [
			{
				uuid: uuid("visits"),
				name: "Visits",
				forms: [
					{
						uuid: visit,
						name: "Visit",
						type: "survey",
						fields: [
							f({
								kind: "text",
								uuid: uuid("remarks"),
								id: "remarks",
								label: proseText("Remarks"),
								label_media: {
									image: mediaIds.label,
									audio: mediaIds.audio,
								},
							}),
							f({
								kind: "single_select",
								uuid: uuid("answer"),
								id: "answer",
								label: proseText("Answer"),
								options: [
									{
										value: "yes",
										label: "Yes",
										media: { audio: mediaIds.audio },
									},
									{ value: "no", label: "No" },
								],
							}),
							f({
								kind: "text",
								uuid: uuid("photo"),
								id: "photo",
								label: proseText("Photo"),
								label_media: { image: mediaIds.option },
							}),
						],
					},
				],
			},
			{
				uuid: uuid("registrations"),
				name: "Registrations",
				caseType: "patient",
				caseListConfig: caseListOf([
					plainColumn(uuid("registered-name-column"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: register,
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("name"),
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
			{
				uuid: uuid("patients"),
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListOf([
					plainColumn(uuid("name-column"), "case_name", "Name"),
					imageMapColumn(uuid("status-column"), "care_status", "Status", [
						imageMapEntry("active", mediaIds.icon),
						imageMapEntry("closed", mediaIds.icon),
					]),
				]),
				forms: [
					{
						uuid: uuid("review"),
						name: "Review",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("notes"),
								id: "notes",
								label: proseText("Notes"),
							}),
						],
					},
				],
			},
		],
	});
	const visits = doc.modules[uuid("visits")];
	const patients = doc.modules[uuid("patients")];
	const form = doc.forms[visit];
	if (visits === undefined || patients === undefined || form === undefined) {
		throw new Error("The missing-media document lost a menu or its survey.");
	}
	visits.icon = mediaIds.icon;
	form.audioLabel = mediaIds.audio;
	patients.caseListRegistrationForm = {
		kind: "always",
		formUuid: register,
		icon: mediaIds.icon,
		afterSubmit: "case-list",
	};
	const media = uploadedMedia(mediaManifest());
	return targetedDocument({
		id,
		rows: ["a media reference with no file, on each slot a runtime draws"],
		doc,
		...(media !== undefined && { media }),
		expected: {
			intent: [answerHeld("remarks-held", visit, "/data/remarks", "proof")],
		},
	});
}
