/**
 * Case writes to `state`, `category` and hyphenated properties
 * (`targeted-case-write-names`).
 *
 * A case write's property takes the catalog's grammar,
 * `^[A-Za-z][A-Za-z0-9_-]*$` (`lib/domain/caseOperationIdentifiers.ts`), and
 * `category` and `state` are ordinary properties: CommCare HQ stores each as
 * any other (`update_strategy.py::_apply_update_action`), and Core keeps each
 * in the case's property map (`Case.java::setCategory`, `setState`). A menu of
 * members, each the child of a household:
 *
 * - the registration saves `state`, `category`, `first-name` and
 *   `visit-count`;
 * - the follow-up opens each question on the value saved, saves all four
 *   again, and saves `first-name` and `visit-count` to the member's
 *   household too, by a Save to Case update of that parent case;
 * - the case list shows each saved property in a column.
 *
 * What it would catch: HQ's case processing and Core disagreeing on a saved
 * value, or the form builder altering a Save to Case row whose property holds
 * a hyphen.
 *
 * Fixed values: the follow-up, opened on the member `targeted-member`, holds
 * its state as answered.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type CaseOperation,
	type Expression,
	plainColumn,
	proseText,
} from "@/lib/domain";
import {
	ancestorPath,
	formField,
	prop,
	relationStep,
	term,
} from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

const ID = "targeted-case-write-names";
const uuid = (name: string) => targetedUuid(ID, name);

/** Text `buildDoc` parses in its slot. */
const text = (source: string) => source as unknown as Expression;

const PROPERTIES = [
	["state", "State", "text"],
	["category", "Category", "text"],
	["first-name", "First name", "text"],
	["visit-count", "Visit count", "int"],
] as const;

/** One question per saved property, saved to the member, opening on the
 * member's value where `preload` holds. */
function questions(form: string, preload: boolean) {
	return PROPERTIES.map(([property, label, kind]) =>
		f({
			kind,
			uuid: uuid(`${form}-${property}`),
			id: property,
			label: proseText(label),
			...(preload && { default_value: text(`#member/${property}`) }),
			caseWrite: { caseType: "member", property },
		}),
	);
}

export function caseWriteNames() {
	const visit = uuid("visit");
	const household: CaseOperation = {
		uuid: uuid("update-household"),
		id: "household",
		action: "update",
		caseType: "household",
		// The member's household: the case its `parent` index names.
		target: {
			kind: "expression",
			expr: term(
				prop("member", "case_id", ancestorPath(relationStep("parent"))),
			),
		},
		writes: [
			{
				property: "first-name",
				value: term(formField(uuid("visit-first-name"))),
			},
			{
				property: "visit-count",
				value: term(formField(uuid("visit-visit-count"))),
			},
		],
	} as CaseOperation;
	const doc = buildDoc(
		{
			appId: ID,
			appName: "Household members",
			caseTypes: [
				{
					name: "household",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{
							name: "first-name",
							label: proseText("First name"),
							data_type: "text",
						},
						{
							name: "visit-count",
							label: proseText("Visit count"),
							data_type: "int",
						},
					],
				},
				{
					name: "member",
					parent_type: "household",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						...PROPERTIES.map(([name, label, kind]) => ({
							name,
							label: proseText(label),
							data_type: kind,
						})),
					],
				},
			],
			modules: [
				{
					uuid: uuid("members"),
					name: "Members",
					caseType: "member",
					caseListConfig: caseListOf([
						plainColumn(uuid("name-column"), "case_name", "Name"),
						...PROPERTIES.map(([property, label]) =>
							plainColumn(uuid(`${property}-column`), property, label),
						),
					]),
					forms: [
						{
							uuid: uuid("register"),
							name: "Register member",
							type: "registration",
							fields: [
								f({
									kind: "text",
									uuid: uuid("name"),
									id: "name",
									label: proseText("Name"),
									caseWrite: { caseType: "member", property: "case_name" },
								}),
								...questions("register", false),
							],
						},
						{
							uuid: visit,
							name: "Visit member",
							type: "followup",
							fields: questions("visit", true),
						},
					],
				},
			],
		},
		(built) => {
			built.forms[visit].caseOperations = [household];
		},
	);
	return targetedDocument({
		id: ID,
		rows: ["names, a case write to state, category or a hyphenated property"],
		doc,
		expected: {
			intent: [
				answerHeld("state-held", visit, "/data/state", "active", "local", {
					command: "m0-f1",
					caseId: "targeted-member",
				}),
			],
		},
	});
}
