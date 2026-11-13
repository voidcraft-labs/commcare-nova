/**
 * Case types in the whole of HQ's editor grammar (`targeted-case-type-names`).
 *
 * A case type is HQ's menu page's grammar, `^[A-Za-z0-9_-]+$`
 * (`app_manager.js::valueIncludeInvalidCharacters`), and no type is refused
 * for being one of reference text's fixed words: HQ's own fallback case type
 * is `case` (`views/modules.py::_init_module_case_type`). The emitter writes a
 * case type into string literals, session datum ids (`case_id_new_<type>_<n>`,
 * `case_id_case_<type>`), advanced tags and the ids Nova mints for a case
 * change. Menus of the types:
 *
 * - `case`, whose registration creates its child of the type `1st-visit`,
 *   owned by no one (`-`), which a basic subcase cannot state since HQ's
 *   basic build gives every subcase the worker
 *   (`xform.py::autoset_owner_id_for_subcase`), and links after submit to
 *   the `1st-visit` follow-up, which carries the new child, so the create is
 *   an advanced open action and its menu an advanced one;
 * - `1st-visit`, whose follow-up reads its parent's `region`, written
 *   `#record/case/region` because `case` is a fixed word of reference text,
 *   and its own `#1st-visit/outcome`;
 * - `parent`, whose follow-up creates an extension of the type `2024` and
 *   one of the type `-flagged`, each a Save to Case block named by the id
 *   Nova mints for its type (`case_2024`, `case__flagged`), since neither type
 *   is a question ID as it stands;
 * - `-flagged` and `2024`, each with a case list and a follow-up.
 *
 * What it would catch: a datum id, tag or minted operation id some reader
 * cannot take; a reference that binds another record; a load entry HQ's
 * summary reads as a worker's; a Save to Case block HQ's form builder refuses
 * or warns about on its two saves.
 *
 * Fixed values: the `2024` follow-up, opened on the case `targeted-2024`,
 * holds its note as answered.
 */

import { buildDoc, type FormSpec, f } from "@/lib/__tests__/docHelpers";
import { type CaseOperation, plainColumn, proseText } from "@/lib/domain";
import { formField, term, unowned } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-case-type-names";
const uuid = (name: string) => targetedUuid(ID, name);
const read = (key: string) => term(formField(uuid(key)));

function caseType(
	name: string,
	properties: readonly string[],
	parent?: { readonly type: string; readonly relationship?: "extension" },
) {
	return {
		name,
		...(parent !== undefined && { parent_type: parent.type }),
		...(parent?.relationship !== undefined && {
			relationship: parent.relationship,
		}),
		properties: [
			{ name: "case_name", label: proseText("Name") },
			...properties.map((property) => ({
				name: property,
				label: proseText(property),
				data_type: "text" as const,
			})),
		],
	};
}

const text = (
	key: string,
	label: string,
	extra: Record<string, unknown> = {},
) =>
	f({
		kind: "text",
		uuid: uuid(key),
		id: key.replaceAll("-", "_"),
		label: proseText(label),
		...extra,
	});

/** A menu of `caseType` with a case list and the forms given. */
function menu(key: string, name: string, caseType: string, forms: FormSpec[]) {
	return {
		uuid: uuid(key),
		name,
		caseType,
		caseListConfig: caseListOf([
			plainColumn(uuid(`${key}-name-column`), "case_name", "Name"),
		]),
		forms,
	};
}

/** The extension of `caseType` the `parent` follow-up creates, named by `nameKey`'s answer. */
function extension(
	id: string,
	caseType: string,
	nameKey: string,
): CaseOperation {
	return {
		uuid: uuid(`create-${id}`),
		id,
		action: "create",
		caseType,
		target: { kind: "new" },
		name: read(nameKey),
		links: [
			{
				identifier: "host",
				targetType: "parent",
				target: { kind: "session" },
				relationship: "extension",
			},
		],
	} as CaseOperation;
}

export function caseTypeNames() {
	const registerCase = uuid("register-case");
	const flagParent = uuid("flag-parent");
	const visits = uuid("visits");
	const doc = buildDoc(
		{
			appId: ID,
			appName: "Case type names",
			caseTypes: [
				caseType("case", ["region"]),
				caseType("1st-visit", ["outcome"], { type: "case" }),
				caseType("parent", ["note"]),
				caseType("-flagged", [], { type: "parent", relationship: "extension" }),
				caseType("2024", [], { type: "parent", relationship: "extension" }),
			],
			modules: [
				menu("cases", "Cases", "case", [
					{
						uuid: registerCase,
						name: "Register case",
						type: "registration",
						formLinks: [
							{
								uuid: uuid("open-visits"),
								target: {
									type: "form",
									moduleUuid: visits,
									formUuid: uuid("record-visit"),
								},
							},
						],
						fields: [
							text("case-name", "Name"),
							text("region", "Region", {
								caseWrite: { caseType: "case", property: "region" },
							}),
							text("visit-name", "First visit"),
						],
					},
				]),
				menu("visits", "First visits", "1st-visit", [
					{
						uuid: uuid("record-visit"),
						name: "Record visit",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								uuid: uuid("case-region"),
								id: "case_region",
								calculate: "#record/case/region",
							}),
							text("outcome", "Outcome", {
								default_value: "#1st-visit/outcome",
								caseWrite: { caseType: "1st-visit", property: "outcome" },
							}),
						],
					},
				]),
				menu("parents", "Parents", "parent", [
					{
						uuid: flagParent,
						name: "Flag parent",
						type: "followup",
						fields: [text("year-name", "Year"), text("flag-name", "Flag")],
					},
				]),
				menu("flagged", "Flagged", "-flagged", [
					{
						uuid: uuid("review-flag"),
						name: "Review flag",
						type: "followup",
						fields: [text("flag-note", "Note")],
					},
				]),
				menu("years", "Years", "2024", [
					{
						uuid: uuid("review-year"),
						name: "Review year",
						type: "followup",
						fields: [text("year-note", "Note")],
					},
				]),
			],
		},
		(built) => {
			const own = uuid("register-own");
			built.forms[registerCase].caseOperations = [
				{ uuid: own, id: "case", action: "own", name: read("case-name") },
				{
					uuid: uuid("create-visit"),
					id: "case_1st_visit",
					action: "create",
					caseType: "1st-visit",
					target: { kind: "new" },
					name: read("visit-name"),
					owner: unowned(),
					links: [
						{
							identifier: "parent",
							targetType: "case",
							target: { kind: "op", opUuid: own },
							relationship: "child",
						},
					],
				} as CaseOperation,
			];
			built.forms[flagParent].caseOperations = [
				extension("case_2024", "2024", "year-name"),
				extension("case__flagged", "-flagged", "flag-name"),
			];
		},
	);
	return targetedDocument({
		id: ID,
		rows: ["names, a case type in HQ's editor grammar"],
		doc,
		expected: {
			intent: [
				answerHeld(
					"year-note-held",
					uuid("review-year"),
					"/data/year_note",
					"Reviewed",
					"local",
					{ command: "m4-f0", caseId: "targeted-2024" },
				),
			],
		},
	});
}
