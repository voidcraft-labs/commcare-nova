/** Two clinics are about two and ten metres east of the first worker position.
 * Comparing their displayed distances as text reverses the native numeric order. */
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	NEW_APP_SETTINGS,
	plainColumn,
	proseText,
	workerDistanceColumn,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";
import { answerHeld } from "./echo";

export function nearestClinics() {
	const id = "targeted-nearest-clinics";
	const key = (name: string) => targetedUuid(id, name);
	const form = key("visit");
	const doc = buildDoc({
		appId: id,
		appName: "Clinic visits",
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		caseTypes: [
			{
				name: "clinic",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{
						name: "entrance",
						label: proseText("Entrance"),
						data_type: "geopoint",
					},
					{
						name: "position",
						label: proseText("Clinic location"),
						data_type: "geopoint",
					},
				],
			},
		],
		modules: [
			{
				uuid: key("clinics"),
				name: "Clinics",
				caseType: "clinic",
				caseListConfig: caseListOf([
					plainColumn(key("name"), "case_name", "Name", {
						sort: { direction: "asc", priority: 1 },
					}),
					plainColumn(key("location"), "position", "Clinic location", {
						visibleInList: false,
						visibleInDetail: false,
						sort: {
							direction: "asc",
							priority: 0,
							comparator: "distance",
							label: "Nearest clinic",
						},
					}),
					workerDistanceColumn(
						key("distance"),
						"entrance",
						"Distance from entrance",
					),
				]),
				forms: [
					{
						uuid: form,
						name: "Visit clinic",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: key("notes"),
								id: "notes",
								label: proseText("Visit notes"),
							}),
						],
					},
				],
			},
		],
	});
	const restore = restoreXml({
		cases: [
			{
				id: "far",
				type: "clinic",
				name: "Asha",
				properties: { position: "0 0.00009 0 5", entrance: "0 0.001345 0 5" },
			},
			{
				id: "near",
				type: "clinic",
				name: "Zuri",
				properties: { position: "0 0.000018 0 5", entrance: "0 0.004" },
			},
			{ id: "unknown", type: "clinic", name: "Beno", properties: {} },
		],
	});
	return targetedDocument({
		id,
		rows: ["Android distance comparison in Default order"],
		doc,
		expected: {
			intent: [
				answerHeld(
					"clinic-visit-notes",
					form,
					"/data/notes",
					"Arrived",
					"local",
					{ command: "m0-f0", caseId: "near" },
				),
			],
		},
		files: { "restore.xml": restore },
	});
}
