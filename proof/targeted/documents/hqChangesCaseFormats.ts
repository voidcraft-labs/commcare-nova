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

function members(columns: readonly Column[] = []) {
	return buildDoc({
		appId: ID,
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

/** HQ stores this format's path rather than an XPath. Its calculation is the
 * same reached property with the unreferenced enum wording still present.
 */
function reachedColumn(
	header: string,
	ordinal: number,
	path: readonly [string, ...string[]],
) {
	const id = nativeIdentity("calculated", "", ordinal);
	const [first, ...rest] = path;
	return {
		...calculatedColumn(
			id,
			header,
			term({
				kind: "prop",
				caseType: "member",
				property: "zone",
				readReached: true,
				via: {
					kind: "ancestor",
					via: [
						{ identifier: first },
						...rest.map((identifier) => ({ identifier })),
					],
				},
			}),
			onlyOnList,
		),
		texts: [
			{
				uuid: mintEntityUuid(ID, externalKey.caseCalculationText(id, "guide")),
				label: "Area guide",
			},
		],
	};
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
		reachedColumn("Parent area", 1, ["parent"]),
		reachedColumn("Host parent area", 2, ["host", "parent"]),
	];
	const after = members(added);
	const columns =
		expandDoc(after).modules[0]?.case_details.short.columns.slice(1);
	if (columns?.length !== added.length)
		throw new Error("The Case List save must hold each added format.");
	const authored = columns.map((column, index) => {
		const path =
			index === added.length - 2
				? "parent/zone"
				: index === added.length - 1
					? "host/parent/zone"
					: undefined;
		return path === undefined
			? column
			: {
					...column,
					field: path,
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
				};
	});
	return {
		...document,
		hqSide: {
			// HQ's Case List page offers a calculated property only after the
			// app enables Calculate Case List Properties.
			addOns: {
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
			},
			moduleDetail: {
				module: 0,
				columns: authored as unknown as readonly Readonly<
					Record<string, unknown>
				>[],
			},
			republish: "brings-in",
			publishChanges: [],
			bringsIn: broughtInDocument(document, after),
		},
	};
}
