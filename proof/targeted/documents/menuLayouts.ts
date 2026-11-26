import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { proseText } from "@/lib/domain";
import { uploadedMedia } from "../../corpus/documents";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

/** No module puts forms on the first menu, so HQ must supply its empty
 * styled root. A child in Services contributes a grid beside its parent's
 * unstylized block. In the other menu the same spoken label has a visible
 * Web Apps player. */
export function menuLayouts() {
	const id = "targeted-menu-layouts";
	const key = (value: string) => targetedUuid(id, value);
	const survey = (name: string) => ({
		uuid: key(name),
		name,
		type: "survey" as const,
		fields: [
			f({
				kind: "text",
				uuid: key(`${name}-note`),
				id: "note",
				label: proseText("Note"),
			}),
		],
	});
	const doc = buildDoc({
		appId: id,
		appName: "Community visits",
		appSettings: {
			showSavedForms: false,
			showIncompleteForms: false,
			firstMenuLayout: "grid",
			formMenuLayout: "individual",
		},
		modules: [
			{
				uuid: key("services"),
				name: "Services",
				forms: [survey("Check supplies")],
			},
			{
				uuid: key("outreach"),
				name: "Outreach",
				forms: [survey("Record visit")],
			},
			{
				uuid: key("support"),
				name: "Support",
				forms: [survey("Request help"), survey("Leave a message")],
			},
		],
	});
	doc.modules[key("outreach")].parentModuleUuid = key("services");
	doc.modules[key("outreach")].formsInMenuAbove = true;
	doc.modules[key("outreach")].menuLayout = "grid";
	doc.modules[key("services")].audioLabel = mediaIds.audio;
	for (const name of ["Record visit", "Request help"])
		doc.forms[key(name)].audioLabel = mediaIds.audio;
	const media = uploadedMedia(mediaManifest());
	const edit = structuredClone(doc);
	delete edit.appSettings.firstMenuLayout;
	edit.appSettings.formMenuLayout = "grid";
	return targetedDocument({
		id,
		doc,
		edit,
		rows: [
			"menu layout on a synthetic first menu, shared parent form menu and ordinary form list",
		],
		...(media !== undefined && { media }),
		expected: {
			intent: [
				answerHeld(
					"continued-visit",
					key("Record visit"),
					"/data/note",
					"Visited",
					"A",
				),
			],
		},
	});
}
