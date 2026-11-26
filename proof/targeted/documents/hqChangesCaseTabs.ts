/** Two tabs added to the Case Detail through HQ's native view. Their existing
 * fields stay on the same menu, and each tab is anchored by its own field.
 */
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { externalKey, mintEntityUuid } from "@/lib/commcare/reader/identity";
import { derivedUniqueId } from "@/lib/commcare/wireIdentity";
import { plainColumn, proseText } from "@/lib/domain";
import type { CorpusDocument } from "../../corpus/documents";
import {
	broughtInDocument,
	caseListOf,
	targetedDocument,
	targetedUuid,
} from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-hq-changes-case-detail-tabs";
const uuid = (key: string) => targetedUuid(ID, key);

export function hqChangesCaseTabs(): CorpusDocument {
	const moduleUuid = uuid("members");
	const visit = uuid("visit");
	const fields = [
		plainColumn(uuid("name"), "case_name", "Name"),
		plainColumn(uuid("contact"), "contact", "Contact"),
	];
	const before = buildDoc({
		appId: ID,
		appName: "Visit details",
		caseTypes: [
			{
				name: "member",
				properties: [{ name: "contact", label: proseText("Contact") }],
			},
		],
		modules: [
			{
				uuid: moduleUuid,
				name: "Members",
				caseType: "member",
				caseListConfig: caseListOf(fields),
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
							}),
						],
					},
				],
			},
		],
	});
	const document = targetedDocument({
		id: ID,
		doc: before,
		rows: ["Case Detail tabs added in CommCare HQ, brought in"],
		expected: {
			intent: [
				answerHeld("note-held", visit, "/data/note", "Checked", "local", {
					command: "m0-f0",
					caseId: "detail-tabs-member",
				}),
			],
		},
	});
	const after = structuredClone(before);
	const config = after.modules[moduleUuid]?.caseListConfig;
	if (!config) throw new Error("Missing case detail");
	config.detailTabs = fields.map((column, index) => ({
		uuid: mintEntityUuid(
			ID,
			externalKey.caseDetailTab(
				externalKey.caseListColumn(
					derivedUniqueId(moduleUuid),
					"plain",
					column.field,
					0,
				),
				[],
			),
		),
		title: index === 0 ? "Identity" : "Contact information",
		startColumnUuid: column.uuid,
	}));
	const tabs = expandDoc(after).modules[0]?.case_details.long.tabs;
	if (tabs?.length !== fields.length)
		throw new Error("The Case Detail save must hold both tabs.");
	return {
		...document,
		hqSide: {
			moduleDetail: {
				module: 0,
				tabs: tabs as unknown as readonly Readonly<Record<string, unknown>>[],
			},
			republish: "brings-in",
			publishChanges: [],
			bringsIn: broughtInDocument(document, after),
		},
	};
}
