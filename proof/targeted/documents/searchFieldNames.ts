/**
 * A Search field whose name holds a hyphen (`targeted-search-field-names`).
 *
 * A Search field's name starts with a letter or an underscore and holds
 * letters, digits, underscores and hyphens
 * (`lib/domain/modules.ts::SEARCH_INPUT_NAME_PATTERN`). It is the prompt's
 * `key`, the name `instance('search-input:results')/input/field[@name=…]`
 * reads, a locale id's last segment and the segment of `#search/<name>`. A
 * menu of clients searches by the fields `first-name` and `dob_from`, and
 * reads `#search/first-name`:
 *
 * - in its case list's filter;
 * - in the forms that read the search, which run it as each opens;
 * - in the registration its case list offers after a search finds nothing,
 *   whose name starts from what was searched for.
 *
 * What it would catch: HQ's search view or Core's query screen binding the
 * key to another field, or a read of the key that names no answer.
 *
 * A menu whose forms read the search runs in Web Apps alone, so the app
 * declares Web Apps and has no local archive.
 *
 * Fixed values: the follow-up of HQ's build, opened on the client
 * `targeted-client`, holds its note as answered.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type Expression,
	plainColumn,
	proseText,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, input, prop, whenInput } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-search-field-names";
const uuid = (name: string) => targetedUuid(ID, name);

/** Text `buildDoc` parses in its slot. */
const text = (source: string) => source as unknown as Expression;

export function searchFieldNames() {
	const firstName = uuid("first-name-input");
	const note = uuid("note");
	const doc = buildDoc({
		appId: ID,
		appName: "Client search",
		caseTypes: [
			{
				name: "client",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "dob", label: proseText("Date of birth"), data_type: "date" },
				],
			},
		],
		modules: [
			{
				uuid: uuid("clients"),
				name: "Clients",
				caseType: "client",
				caseSearchConfig: { formsReadSearch: true },
				caseListRegistrationForm: {
					formUuid: `targeted:${ID}:register`,
					label: "Register a client",
				},
				caseListConfig: caseListOf(
					[plainColumn(uuid("name-column"), "case_name", "Name")],
					{
						searchInputs: [
							simpleSearchInputDef(
								firstName,
								"first-name",
								"First name",
								"text",
								"case_name",
							),
							simpleSearchInputDef(
								uuid("dob-from-input"),
								"dob_from",
								"Born on",
								"date",
								"dob",
							),
						],
						filter: whenInput(
							input(firstName),
							eq(prop("client", "case_name"), input(firstName)),
						),
					},
				),
				forms: [
					{
						uuid: note,
						name: "Note",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								uuid: uuid("searched-name"),
								id: "searched_name",
								calculate: text("#search/first-name"),
							}),
							f({
								kind: "text",
								uuid: uuid("note-text"),
								id: "note",
								label: proseText("Note"),
							}),
						],
					},
					{
						uuid: uuid("register"),
						name: "Register client",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("register-name"),
								id: "case_name",
								label: proseText("Name"),
								default_value: text("#search/first-name"),
								caseWrite: { caseType: "client", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["names, a Search field name holding a hyphen"],
		doc,
		expected: {
			intent: [
				answerHeld("note-held", note, "/data/note", "seen", "A", {
					command: "m0-f0",
					caseId: "targeted-client",
				}),
			],
		},
	});
}
