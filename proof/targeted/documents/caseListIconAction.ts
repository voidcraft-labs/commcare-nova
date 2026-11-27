import {
	listIconVisits,
	visitActionForm,
} from "@/lib/__tests__/listIconVisits";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { uploadedMedia } from "../../corpus/documents";
import { targetedDocument } from "../build";
import { restoreXml } from "../restore";

export function caseListIconAction() {
	const id = "targeted-case-list-icon-action";
	const doc = listIconVisits(id, mediaIds.label);
	const form = visitActionForm;
	const media = uploadedMedia(mediaManifest());
	return targetedDocument({
		id,
		rows: ["case list icon submits its form for the chosen visit"],
		doc,
		...(media && { media }),
		expected: {
			intent: [
				{
					id: "two-visits",
					export: "A",
					form,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f0" },
						caseList: { searchText: "Second" },
					},
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "second-visit" },
						{ pointer: "/caseList/rows/0/fields/0", value: "Second visit" },
					],
				},
			],
		},
		files: {
			"restore.xml": restoreXml({
				cases: [
					{
						id: "first-visit",
						type: "visit",
						name: "First visit",
						properties: { visit_state: "ready" },
					},
					{
						id: "second-visit",
						type: "visit",
						name: "Second visit",
						properties: { visit_state: "ready" },
					},
				],
			}),
		},
	});
}
