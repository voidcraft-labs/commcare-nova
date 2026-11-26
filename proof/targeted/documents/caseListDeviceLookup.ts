import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { NEW_APP_SETTINGS, plainColumn, proseText } from "@/lib/domain";
import { uploadedMedia } from "../../corpus/documents";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";
import { answerHeld } from "./echo";

export function caseListDeviceLookupCount() {
	return caseListDeviceLookup(true);
}

export function caseListDeviceLookup(count = false) {
	const id = count ? "targeted-case-list-device-lookup-count" : "targeted-case-list-device-lookup";
	const uuid = (name: string) => targetedUuid(id, name);
	const module = uuid("list");
	const visit = uuid("visit");
	const icon = mediaManifest().get(mediaIds.icon);
	if (!icon?.bytes) throw new Error("Missing case lookup icon.");
	const media = uploadedMedia(new Map([[mediaIds.icon, icon]]));
	return targetedDocument({
		id,
		...(media && { media }),
		rows: [
			"Android case list lookup keeps the companion action and text response order",
		],
		doc: buildDoc({
			appId: id,
			...(count && { appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" } }),
			appName: "Case list lookup",
			caseTypes: [{ name: "visit", properties: [] }],
			modules: [
				{
					uuid: module,
					name: "Visits",
					caseType: "visit",
					caseListConfig: {
						...caseListOf([plainColumn(uuid("name"), "case_name", "Name")]),
						deviceLookup: {
							action: "org.nova.proof.CASE_LOOKUP",
							label: "Find a visit",
							resultHeading: "Confidence",
							icon: mediaIds.icon,
							...(!count && { automatic: true }),
							extras: [
								{ name: "visit_mode", value: "followup" },
								{ name: "visit_limit", value: "3" },
								{
									name: "worker_name",
									expression: {
										kind: "term",
										term: { kind: "session-context", field: "username" },
									},
								},
								{
									name: "worker_id",
									expression: {
										kind: "term",
										term: { kind: "session-context", field: "userid" },
									},
								},
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
								...(count ? [f({
									kind: "hidden", id: "lookup_count",
									calculate: { kind: "case-list-lookup-count", module },
								})] : []),
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
