/**
 * The restores a targeted document's expectations run over: the case data and
 * lookup rows a phone holds, in the shape HQ's OTA restore serves them, which
 * Core's transaction parsers read (`proof/core/src/nova/proof/core/CaseData.java::sandbox`).
 *
 * The frame is Core's own template restore
 * (`commcare-core/src/test/resources/template/user_restore.xml`): its sync
 * token and its one registered user, `test_uuid`, whom Core logs in. Cases are
 * case XML v2 blocks for a phone that holds nothing
 * (`casexml/apps/phone/data_providers/case/utils.py::CaseSyncUpdate`, every
 * property in the create and update); a lookup table is the item list HQ's
 * restore serves for it (`fixtures/fixturegenerators.py::ItemListsProvider._get_fixture_element`
 * and `to_xml`: `<fixture id="item-list:<tag>" user_id>`, a `<tag>_list`, one
 * `<tag>` per row with one element per field); the places a worker's
 * restore holds are HQ's flat location fixture
 * (`locations/fixtures.py::FlatLocationSerializer.get_xml_nodes`): the index
 * schema `fixtures/utils.py::get_index_schema_node` writes (`<schema
 * id="locations">`, each level's `@<code>_id`, `@id`, `@type` and `name`,
 * sorted), then `<fixture id="locations" user_id indexed="true">` with one
 * `<location>` per place in site-code order carrying its level code as
 * `type`, its id and each level's ancestor id as `<code>_id`, then its name,
 * site code, external id, coordinates, level name as `location_type`
 * (`LocationType.__str__`), supply point and every location data field
 * (`_fill_in_location_element`, `_get_metadata_node`), blank where unset.
 */

import type { ChildNode } from "domhandler";
import { el, text } from "@/lib/commcare/elementBuilders";
import { serializeXml } from "@/lib/commcare/serializeXml";

/** The user Core's template restore registers, and whom every case below belongs to unless it names another owner. */
export const RESTORE_USER_ID = "test_uuid";
const CASE_XMLNS = "http://commcarehq.org/case/transaction/v2";

export interface RestoreCase {
	readonly id: string;
	readonly type: string;
	readonly name: string;
	/** The case's owner, where it is not the restore's user. */
	readonly owner?: string;
	/** Custom properties, in the order the case's update writes them. */
	readonly properties?: Readonly<Record<string, string>>;
	/** The case's child indices, each naming the case it points at and that case's type. */
	readonly indices?: readonly {
		readonly identifier: string;
		readonly caseType: string;
		readonly caseId: string;
	}[];
}

export interface RestoreTable {
	readonly tag: string;
	/** Field names in the table's order, then one row per entry, a value per field. */
	readonly fields: readonly string[];
	readonly rows: readonly (readonly string[])[];
}

function caseBlock(entry: RestoreCase): ChildNode {
	const create = el("create", {}, [
		el("case_type", {}, [text(entry.type)]),
		el("case_name", {}, [text(entry.name)]),
		el("owner_id", {}, [text(entry.owner ?? RESTORE_USER_ID)]),
	]);
	const children: ChildNode[] = [create];
	const properties = Object.entries(entry.properties ?? {});
	if (properties.length > 0) {
		children.push(
			el(
				"update",
				{},
				properties.map(([name, value]) => el(name, {}, [text(value)])),
			),
		);
	}
	// HQ's restore writes the indices after the update, sorted by identifier
	// (`casexml/apps/phone/xml.py::get_case_element`,
	// `case/xml/generator.py::V2CaseXMLGenerator.add_indices`).
	const indices = [...(entry.indices ?? [])].sort((a, b) =>
		a.identifier < b.identifier ? -1 : a.identifier > b.identifier ? 1 : 0,
	);
	if (indices.length > 0) {
		children.push(
			el(
				"index",
				{},
				indices.map((index) =>
					el(index.identifier, { case_type: index.caseType }, [
						text(index.caseId),
					]),
				),
			),
		);
	}
	return el(
		"case",
		{
			case_id: entry.id,
			date_modified: "2026-01-01T00:00:00.000000Z",
			user_id: RESTORE_USER_ID,
			xmlns: CASE_XMLNS,
		},
		children,
	);
}

function fixture(table: RestoreTable): ChildNode {
	return el(
		"fixture",
		{ id: `item-list:${table.tag}`, user_id: RESTORE_USER_ID },
		[
			el(
				`${table.tag}_list`,
				{},
				table.rows.map((row) =>
					el(
						table.tag,
						{},
						table.fields.map((field, index) =>
							el(field, {}, [text(row[index] ?? "")]),
						),
					),
				),
			),
		],
	);
}

export interface RestorePlace {
	readonly id: string;
	/** The place's level code (`@type`) and the level's name (`location_type`). */
	readonly level: string;
	readonly levelName: string;
	/** Every level code of the organization, each with this place's ancestor
	 *  at that level (its own id at its own level, blank where it has none). */
	readonly lineage: Readonly<Record<string, string>>;
	readonly name: string;
	readonly siteCode: string;
	/** Every location data field, in definition order, blank where unset. */
	readonly data?: Readonly<Record<string, string>>;
}

/** HQ's index schema and flat fixture for these places. */
function places(entries: readonly RestorePlace[]): ChildNode[] {
	const ordered = [...entries].sort((a, b) =>
		a.siteCode < b.siteCode ? -1 : a.siteCode > b.siteCode ? 1 : 0,
	);
	const levels = [
		...new Set(entries.flatMap((place) => Object.keys(place.lineage))),
	];
	const indices = [
		...levels.map((code) => `@${code}_id`),
		"@id",
		"@type",
		"name",
	].sort();
	const schema = el("schema", { id: "locations" }, [
		el(
			"indices",
			{},
			indices.map((index) => el("index", {}, [text(index)])),
		),
	]);
	const fixture = el(
		"fixture",
		{ id: "locations", user_id: RESTORE_USER_ID, indexed: "true" },
		[
			el(
				"locations",
				{},
				ordered.map((place) =>
					el(
						"location",
						{
							type: place.level,
							id: place.id,
							...Object.fromEntries(
								Object.entries(place.lineage).map(([code, id]) => [
									`${code}_id`,
									id,
								]),
							),
						},
						[
							el("name", {}, [text(place.name)]),
							el("site_code", {}, [text(place.siteCode)]),
							el("external_id", {}, []),
							el("latitude", {}, []),
							el("longitude", {}, []),
							el("location_type", {}, [text(place.levelName)]),
							el("supply_point_id", {}, []),
							el(
								"location_data",
								{},
								Object.entries(place.data ?? {}).map(([slug, value]) =>
									el(slug, {}, value === "" ? [] : [text(value)]),
								),
							),
						],
					),
				),
			),
		],
	);
	return [schema, fixture];
}

/** A restore holding these cases, lookup tables and places for Core's template user. */
export function restoreXml(
	content: {
		readonly cases?: readonly RestoreCase[];
		readonly tables?: readonly RestoreTable[];
		readonly places?: readonly RestorePlace[];
	} = {},
): string {
	const root = el("OpenRosaResponse", {}, [
		el("message", { nature: "ota_restore_success" }, [
			text("Successfully restored account test!"),
		]),
		el("Sync", { xmlns: "http://commcarehq.org/sync" }, [
			el("restore_id", {}, [text("sync_token")]),
		]),
		el("Registration", { xmlns: "http://openrosa.org/user/registration" }, [
			el("username", {}, [text("test")]),
			el("password", {}, [
				text("sha1$60441$53cf77c2ac3608a944db96af177a6dfe1579e4ba"),
			]),
			el("uuid", {}, [text(RESTORE_USER_ID)]),
			el("date", {}, [text("2012-04-30")]),
		]),
		...(content.tables ?? []).map(fixture),
		...(content.places === undefined ? [] : places(content.places)),
		...(content.cases ?? []).map(caseBlock),
	]);
	return `${serializeXml(root)}\n`;
}
