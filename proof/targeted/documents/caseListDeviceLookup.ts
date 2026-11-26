import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { plainColumn, proseText } from "@/lib/domain";
import { uploadedMedia } from "../../corpus/documents";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";
import { answerHeld } from "./echo";

const ID = "targeted-case-list-device-lookup";
const uuid = (name: string) => targetedUuid(ID, name);

export function caseListDeviceLookup() {
	const visit = uuid("visit");
	const icon = mediaManifest().get(mediaIds.icon);
	if (!icon?.bytes) throw new Error("Missing case lookup icon.");
	const media = uploadedMedia(new Map([[mediaIds.icon, icon]]));
	return targetedDocument({
		id: ID,
		...(media && { media }),
		rows: [
			"Android case list lookup keeps the companion action and text response order",
		],
		doc: buildDoc({
			appId: ID,
			appName: "Case list lookup",
			caseTypes: [{ name: "visit", properties: [] }],
			modules: [
				{
					uuid: uuid("list"),
					name: "Visits",
					caseType: "visit",
					caseListConfig: {
						...caseListOf([plainColumn(uuid("name"), "case_name", "Name")]),
						deviceLookup: {
							action: "org.nova.proof.CASE_LOOKUP",
							label: "Find a visit",
							icon: mediaIds.icon,
							automatic: true,
							extras: [
								{ name: "visit_mode", value: "followup" },
								{ name: "visit_limit", value: "3" },
							],
							responses: ["first", "second"],
						},
					},
					forms: [
						{
							uuid: visit,
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "text", id: "note", label: proseText("Note") }),
							],
						},
					],
				},
			],
		}),
		files: {
			"restore.xml": restoreXml({
				cases: [
					{ id: "lookup-cedar", type: "visit", name: "Cedar", properties: {} },
					{
						id: "lookup-juniper",
						type: "visit",
						name: "Juniper",
						properties: {},
					},
				],
			}),
		},
		expected: {
			intent: [
				answerHeld("note", visit, "/data/note", "Inspected", "local", {
					command: "m0-f0",
					caseId: "lookup-cedar",
				}),
			],
		},
	});
}
