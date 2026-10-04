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
 * `<tag>` per row with one element per field).
 */

import type { ChildNode } from "domhandler";
import { el, text } from "@/lib/commcare/elementBuilders";
import { serializeXml } from "@/lib/commcare/serializeXml";

/** The user Core's template restore registers, and whom every case below belongs to. */
export const RESTORE_USER_ID = "test_uuid";
const CASE_XMLNS = "http://commcarehq.org/case/transaction/v2";

export interface RestoreCase {
	readonly id: string;
	readonly type: string;
	readonly name: string;
	/** Custom properties, in the order the case's update writes them. */
	readonly properties?: Readonly<Record<string, string>>;
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
		el("owner_id", {}, [text(RESTORE_USER_ID)]),
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

/** A restore holding these cases and lookup tables for Core's template user. */
export function restoreXml(
	content: {
		readonly cases?: readonly RestoreCase[];
		readonly tables?: readonly RestoreTable[];
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
		...(content.cases ?? []).map(caseBlock),
	]);
	return `${serializeXml(root)}\n`;
}
