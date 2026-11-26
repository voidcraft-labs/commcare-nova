/** A Case List image map added in HQ reuses picture bytes the Project
 * already published on the visit form. Its matching rule and description
 * are part of the case view's import and second publish.
 */
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { expandDoc } from "@/lib/commcare/expander";
import { externalKey, mintEntityUuid } from "@/lib/commcare/reader/identity";
import { derivedUniqueId } from "@/lib/commcare/wireIdentity";
import {
	type Column,
	imageMapColumn,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { type CorpusDocument, uploadedMedia } from "../../corpus/documents";
import {
	broughtInDocument,
	caseListOf,
	targetedDocument,
	targetedUuid,
} from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-hq-changes-case-list-image-map";
const uuid = (key: string) => targetedUuid(ID, key);

export function hqChangesCaseImage(): CorpusDocument {
	const moduleUuid = uuid("members");
	const visit = uuid("visit");
	const doc = (columns: readonly Column[]) =>
		buildDoc({
			appId: ID,
			appName: "Visit markers",
			caseTypes: [
				{
					name: "member",
					properties: [{ name: "zone", label: proseText("Zone") }],
				},
			],
			modules: [
				{
					uuid: moduleUuid,
					name: "Members",
					caseType: "member",
					caseListConfig: caseListOf([
						plainColumn(uuid("name"), "case_name", "Name"),
						...columns,
					]),
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
									label_media: { image: mediaIds.label },
								}),
							],
						},
					],
				},
			],
		});
	const assets = mediaManifest();
	const asset = assets.get(mediaIds.label);
	if (!asset?.bytes) throw new Error("Missing visit marker image");
	const media = uploadedMedia(new Map([[mediaIds.label, asset]]));
	const document = targetedDocument({
		id: ID,
		doc: doc([]),
		rows: ["Case List image mapping added in CommCare HQ, brought in"],
		...(media && { media }),
		expected: {
			intent: [
				answerHeld("note-held", visit, "/data/note", "Marked", "local", {
					command: "m0-f0",
					caseId: "image-map-member",
				}),
			],
		},
	});
	const image = imageMapColumn(
		mintEntityUuid(
			ID,
			externalKey.caseListColumn(
				derivedUniqueId(moduleUuid),
				"image-map",
				"zone",
				0,
			),
		),
		"zone",
		"Marker",
		[
			{
				value: "east",
				match: "exact",
				altText: "East bank marker",
				assetId: mediaIds.label,
			},
		],
		{ visibleInDetail: false },
	);
	const after = doc([image]);
	const column = expandDoc(after, { assets }).modules[0]?.case_details.short
		.columns[1];
	if (column?.format !== "enum-image")
		throw new Error("The Case List save must hold the image map.");
	return {
		...document,
		hqSide: {
			// HQ exposes image mappings after this app enables the Add-ons switch.
			addOns: {
				advanced_itemsets: false,
				calc_xpaths: false,
				case_detail_overwrite: false,
				case_list_menu_item: false,
				conditional_enum: false,
				conditional_form_actions: false,
				display_conditions: false,
				enum_image: true,
				menu_mode: false,
				register_from_case_list: false,
				subcases: false,
				submenus: false,
				empty_case_lists: false,
			},
			moduleDetail: {
				module: 0,
				columns: [column as unknown as Readonly<Record<string, unknown>>],
			},
			republish: "brings-in",
			publishChanges: [],
			bringsIn: broughtInDocument(document, after),
		},
	};
}
