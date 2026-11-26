/** An HQ Case List save appends one column of each format. The bring-in must
 * reconstruct all columns while retaining the existing name column and form.
 */
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expandDoc } from "@/lib/commcare/expander";
import { externalKey, mintEntityUuid } from "@/lib/commcare/reader/identity";
import { derivedUniqueId } from "@/lib/commcare/wireIdentity";
import {
	type Column,
	calculatedColumn,
	dateColumn,
	dateCountColumn,
	formattedTextColumn,
	idMappingColumn,
	idMappingEntry,
	mapLayerColumn,
	mapLocationColumn,
	NEW_APP_SETTINGS,
	overdueMarkerColumn,
	phoneColumn,
	plainColumn,
	proseText,
	type Uuid,
	workerDistanceColumn,
} from "@/lib/domain";
import { concat, literal, prop, term } from "@/lib/domain/expression/builders";
import type { CorpusDocument } from "../../corpus/documents";
import {
	broughtInDocument,
	caseListOf,
	targetedDocument,
	targetedUuid,
} from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-hq-changes-case-list-formats";
const uuid = (name: string) => targetedUuid(ID, name);
const menuUuid = uuid("members");
const moduleId = derivedUniqueId(menuUuid);
const visit = uuid("visit");
const onlyOnList = { visibleInDetail: false } as const;
const calculationAddOns = {
	advanced_itemsets: false,
	calc_xpaths: true,
	case_detail_overwrite: false,
	case_list_menu_item: false,
	conditional_enum: false,
	conditional_form_actions: false,
	display_conditions: false,
	enum_image: false,
	menu_mode: false,
	register_from_case_list: false,
	subcases: false,
	submenus: false,
	empty_case_lists: false,
};

function nativeIdentity(
	kind: Column["kind"],
	field: string,
	ordinal = 0,
): Uuid {
	return mintEntityUuid(
		ID,
		externalKey.caseListColumn(moduleId, kind, field, ordinal),
	);
}

function members(columns: readonly Column[] = [], appId = ID) {
	return buildDoc({
		appId,
		appName: "Visit formats",
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		caseTypes: [
			{
				name: "member",
				properties: [
					{ name: "date_due", label: proseText("Due date"), data_type: "date" },
					{ name: "phone", label: proseText("Phone") },
					{ name: "zone", label: proseText("Zone") },
					{ name: "message", label: proseText("Message") },
					{
						name: "position",
						label: proseText("Position"),
						data_type: "geopoint",
					},
					{ name: "boundary", label: proseText("Boundary") },
				],
			},
		],
		modules: [
			{
				uuid: menuUuid,
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
							}),
						],
					},
				],
			},
		],
	});
}

export function hqChangesCaseFormats(): CorpusDocument {
	const document = targetedDocument({
		id: ID,
		doc: members(),
		rows: ["Changes to case list formats made in CommCare HQ, brought in"],
		expected: {
			intent: [
				answerHeld("note-held", visit, "/data/note", "Inspected", "local", {
					command: "m0-f0",
					caseId: "formats-member",
				}),
			],
		},
	});
	const added = [
		dateColumn(
			nativeIdentity("date", "date_due"),
			"date_due",
			"Due date",
			"%Y-%m-%d",
			onlyOnList,
		),
		dateCountColumn(
			nativeIdentity("date-count", "date_due"),
			"date_due",
			"Days since due",
			"days-since",
			onlyOnList,
		),
		overdueMarkerColumn(
			nativeIdentity("overdue-marker", "date_due"),
			"date_due",
			"",
			7,
			onlyOnList,
		),
		phoneColumn(nativeIdentity("phone", "phone"), "phone", "Call", onlyOnList),
		idMappingColumn(
			nativeIdentity("id-mapping", "zone"),
			"zone",
			"Zone",
			[
				idMappingEntry("east", "East bank"),
				idMappingEntry("west", "West bank"),
			],
			onlyOnList,
		),
		formattedTextColumn(
			nativeIdentity("formatted-text", "message"),
			"message",
			"Message",
			onlyOnList,
		),
		mapLocationColumn(
			nativeIdentity("map-location", "position"),
			"position",
			"Map location",
			onlyOnList,
		),
		mapLayerColumn(
			nativeIdentity("map-layer", "boundary"),
			"boundary",
			"Boundary",
			"boundary",
			onlyOnList,
		),
		workerDistanceColumn(
			nativeIdentity("worker-distance", "position"),
			"position",
			"Distance",
			onlyOnList,
		),
		calculatedColumn(
			nativeIdentity("calculated", ""),
			"Visit label",
			concat(term(literal("Visit ")), term(prop("member", "case_name"))),
			onlyOnList,
		),
	];
	const after = members(added);
	const columns =
		expandDoc(after).modules[0]?.case_details.short.columns.slice(1);
	if (columns?.length !== added.length)
		throw new Error("The Case List save must hold each added format.");

	return {
		...document,
		hqSide: {
			// HQ's Case List page offers a calculated property only after the
			// app enables Calculate Case List Properties.
			addOns: calculationAddOns,
			moduleDetail: {
				module: 0,
				columns: columns as unknown as readonly Readonly<
					Record<string, unknown>
				>[],
			},
			republish: "brings-in",
			publishChanges: [],
			bringsIn: broughtInDocument(document, after),
		},
	};
}

/** The import API can retain a legacy related-property translation even
 * though the current editor offers Translatable Text only on calculations. */
export function legacyRelatedCaseText(): CorpusDocument {
	const id = "targeted-legacy-related-case-text";
	const document = targetedDocument({
		id,
		doc: members([], id),
		rows: ["Legacy related case wording gets new generated keys"],
		expected: {
			intent: [
				answerHeld("note-held", visit, "/data/note", "Inspected", "local", {
					command: "m0-f0",
					caseId: "formats-member",
				}),
			],
		},
	});
	const names = ["Parent area", "Host parent area"];
	const paths = [["parent"], ["host", "parent"]] as const;
	const held = paths.map((path, index) => {
		const uuid = mintEntityUuid(
			id,
			externalKey.caseListColumn(moduleId, "calculated", "", index),
		);
		return {
			...calculatedColumn(
				uuid,
				names[index],
				term({
					kind: "prop",
					caseType: "member",
					property: "zone",
					readReached: true,
					via: {
						kind: "ancestor",
						via: [
							{ identifier: path[0] },
							...path.slice(1).map((identifier) => ({ identifier })),
						],
					},
				}),
				onlyOnList,
			),
			texts: [
				{
					uuid: mintEntityUuid(
						id,
						externalKey.caseCalculationText(uuid, "guide"),
					),
					label: "Area guide",
				},
			],
		};
	});
	const after = members(held, id);
	const columns =
		expandDoc(after).modules[0]?.case_details.short.columns.slice(1);
	if (columns?.length !== paths.length)
		throw new Error("Legacy details need both related columns.");
	return {
		...document,
		hqSide: {
			addOns: calculationAddOns,
			moduleDetail: {
				module: 0,
				columns: columns.map((column, index) => ({
					...column,
					field: [...paths[index], "zone"].join("/"),
					format: "translatable-enum",
					useXpathExpression: false,
					enum: [
						{
							doc_type: "MappingItem",
							key: "guide",
							value: { en: "Area guide" },
							alt_text: {},
						},
					],
				})),
			},
			republish: "brings-in",
			publishChanges: ["legacy-related-case-text-rekeyed"],
			bringsIn: broughtInDocument(document, after),
		},
	};
}
