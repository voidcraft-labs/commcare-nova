/**
 * The forms of a menu that opens on Search reading what the search found
 * (`targeted-inline-search-reads`).
 *
 * "Find patient" opens on Search (an inline search: HQ's query step stays in
 * the form's entry, `suite_xml/sections/entries.py`, so the form reads its
 * results at `instance('results:inline')`). Its "Check in" form counts the
 * patients the search found and reads the chosen patient's district from its
 * own search result, both behind the related-case exclusion HQ's own results
 * filter writes (`case_search/const.py::EXCLUDE_RELATED_CASES_FILTER`); its
 * after-submit link reads the same count in its condition, which the suite
 * evaluates on the form's entry. "Check in" also starts a hidden value from
 * the search answer (`#search/patient_name`), which a form of a module that
 * opens on its search reads from `search-input:results:inline`, and "Find
 * patient"'s list shows the same answer in a calculated column. "Register
 * patient" opens only when the search found nothing and starts its name from
 * the search answer too.
 *
 * Fixed values: Core's evaluate opens a form with no search behind it, so
 * the hand-fixed value is the plain "Visit" form's answer; the reads of what
 * the search found, and of the search answer, run on every walk of the
 * document, and the readers' records hold the searched name.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { parseFormExpression } from "@/lib/commcare/xpath/expressionAst";
import {
	type BlueprintDoc,
	calculatedColumn,
	NEW_APP_SETTINGS,
	plainColumn,
	proseText,
	simpleSearchInputDef,
	type Uuid,
} from "@/lib/domain";
import { input, literal, term } from "@/lib/domain/expression";
import type {
	Expression,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-inline-search-reads";
const uuid = (name: string) => targetedUuid(ID, name);

const FOUND =
	"instance('results:inline')/results/case[not(commcare_is_related_case = true())]";

/** `source` as the slot's parser binds it, or a refusal naming why it can't. */
function parsed(
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	source: string,
): Expression {
	const result = parseFormExpression(source, {
		doc,
		slot,
		lookup: new Map(),
	});
	if (!result.ok || result.expression === undefined)
		throw new Error(
			`${ID} reads ${source}, which its slot does not bind: ${
				result.ok
					? "it is empty"
					: result.issues.map((issue) => issue.message).join(" ")
			}`,
		);
	return result.expression;
}

function calculated(doc: BlueprintDoc, field: Uuid, source: string) {
	const held = doc.fields[field];
	if (held?.kind !== "hidden")
		throw new Error(`${ID} has no hidden value ${field}.`);
	held.calculate = parsed(
		doc,
		{ entity: "field", uuid: field, slot: "calculate" },
		source,
	);
}

export function inlineSearchReads() {
	const module = uuid("module");
	const checkIn = uuid("check-in");
	const visit = uuid("visit");
	const found = uuid("found");
	const district = uuid("district");
	const link = uuid("found-link");
	const nameInput = uuid("name-input");
	const doc = buildDoc({
		appId: ID,
		appName: "Patient search",
		// Search first runs in Web Apps alone.
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "web-apps" },
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "district", label: proseText("District") },
				],
			},
		],
		modules: [
			{
				uuid: module,
				name: "Find patient",
				caseType: "patient",
				caseSearchConfig: { searchFirst: true },
				caseListConfig: caseListOf(
					[
						plainColumn(uuid("name-column"), "case_name", "Name"),
						calculatedColumn(
							uuid("searched-column"),
							"Searched for",
							term(input(nameInput)),
						),
					],
					{
						searchInputs: [
							simpleSearchInputDef(
								nameInput,
								"patient_name",
								"Name",
								"text",
								"case_name",
							),
						],
					},
				),
				forms: [
					{
						uuid: checkIn,
						name: "Check in",
						type: "followup",
						postSubmit: "module",
						fields: [
							// Placeholders the parser's reads replace below.
							f({
								kind: "hidden",
								uuid: found,
								id: "found",
								calculate: term(literal(0)),
							}),
							f({
								kind: "hidden",
								uuid: district,
								id: "district",
								calculate: term(literal("")),
							}),
							f({
								kind: "hidden",
								uuid: uuid("searched"),
								id: "searched",
								default_value: term(input(nameInput)),
							}),
						],
						formLinks: [
							{
								uuid: link,
								condition: term(literal(true)),
								target: { type: "form", moduleUuid: module, formUuid: visit },
							},
						],
					},
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
					{
						uuid: uuid("register"),
						name: "Register patient",
						type: "registration",
						entry: { kind: "search-no-matches" },
						fields: [
							f({
								kind: "text",
								uuid: uuid("name"),
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
								default_value: term(input(nameInput)),
							}),
						],
					},
				],
			},
		],
	});
	calculated(doc, found, `count(${FOUND})`);
	calculated(
		doc,
		district,
		`${FOUND}[@case_id = instance('commcaresession')/session/data/case_id]/district`,
	);
	const links = doc.forms[checkIn]?.formLinks;
	const first = links?.[0];
	if (links === undefined || first === undefined)
		throw new Error(`${ID} has no link from Check in.`);
	links[0] = {
		...first,
		condition: parsed(
			doc,
			{
				entity: "form",
				uuid: checkIn,
				slot: "form_link_condition",
				member: { linkUuid: link },
			},
			`count(${FOUND}) > 1`,
		),
	};
	return targetedDocument({
		id: ID,
		rows: ["search-results-read", "no-matches-search-answer"],
		doc,
		expected: {
			intent: [
				answerHeld("note-held", visit, "/data/note", "seen", "A", {
					command: "m0-f1",
					caseId: "targeted-patient",
				}),
			],
		},
	});
}
