/**
 * A menu's case list as a menu entry of its own beside its forms
 * (`targeted-case-list-menu-item`, `Module.caseListMenuItem`).
 *
 * CommCare HQ lists a module's case list in its menu, after its forms, where
 * `case_list.show` is on (`corehq/apps/app_manager/models/case_list.py::CaseList`;
 * `suite_xml/sections/entries.py::EntriesHelper.entry_for_module` writes the
 * `m<N>-case-list` command, `id_strings.py::case_list_command`, and its
 * entry, whose datum selects a case with the module's details and opens no
 * form).
 *
 * - "Households" is forms first: a registration and a follow-up form, and
 *   its case list entry labelled "All households" with an image; its
 *   columns show in Details, so choosing a household from the entry opens
 *   its Details.
 * - "Members" is case first: a follow-up and a close form, and its case list
 *   entry with the menu's own name; no column shows in Details.
 *
 * It declares both platforms. Fixed values: the household follow-up's note
 * holds the text the worker enters (`./echo.ts`).
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	mediaIds,
	mediaManifest,
} from "@/lib/commcare/__tests__/mediaWireFixtures";
import { type Column, plainColumn, proseText } from "@/lib/domain";
import { uploadedMedia } from "../../corpus/documents";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-case-list-menu-item";
const uuid = (name: string) => targetedUuid(ID, name);

/** A note question keyed `key`. */
function note(key: string) {
	return f({
		kind: "text",
		uuid: uuid(key),
		id: "note",
		label: proseText("Note"),
	});
}

/** `column` shown in Results alone. */
function listOnly(column: Column): Column {
	return { ...column, visibleInDetail: false };
}

export function caseListMenuItem() {
	const visit = uuid("visit-household");
	const doc = buildDoc({
		appId: ID,
		appName: "Case list entries",
		caseTypes: [
			{
				name: "household",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{
						name: "village",
						label: proseText("Village"),
						data_type: "text" as const,
					},
				],
			},
			{
				name: "member",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: uuid("households"),
				name: "Households",
				caseType: "household",
				caseListMenuItem: { label: "All households", icon: mediaIds.icon },
				caseListConfig: caseListOf([
					plainColumn(uuid("household-name"), "case_name", "Name"),
					plainColumn(uuid("household-village"), "village", "Village"),
				]),
				forms: [
					{
						uuid: uuid("register-household"),
						name: "Register household",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("household-case-name"),
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "household", property: "case_name" },
							}),
						],
					},
					{
						uuid: visit,
						name: "Visit household",
						type: "followup",
						fields: [note("visit-note")],
					},
				],
			},
			{
				uuid: uuid("members"),
				name: "Members",
				caseType: "member",
				caseListMenuItem: {},
				caseListConfig: caseListOf([
					listOnly(plainColumn(uuid("member-name"), "case_name", "Name")),
				]),
				forms: [
					{
						uuid: uuid("check-member"),
						name: "Check member",
						type: "followup",
						fields: [note("check-note")],
					},
					{
						uuid: uuid("close-member"),
						name: "Close member",
						type: "close",
						fields: [note("close-note")],
					},
				],
			},
		],
	});
	const media = uploadedMedia(mediaManifest());
	return targetedDocument({
		id: ID,
		rows: [
			"case list menu item: beside a menu's forms, forms first and case first",
		],
		doc,
		...(media !== undefined && { media }),
		expected: {
			intent: [
				answerHeld("visit-note-held", visit, "/data/note", "seen", "local", {
					command: "m0-f1",
					caseId: "targeted-household",
				}),
			],
		},
	});
}
