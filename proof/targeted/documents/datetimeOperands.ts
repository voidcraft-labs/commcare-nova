/**
 * Finding 56 on the operand classes `targeted-datetime-ordering` lacks: a
 * date and time held as text ordered against `now()`, against a literal, and
 * against another case property, the last two in case list filters the suite
 * carries.
 *
 * Core compares both sides of an ordering as numbers
 * (`commcare-core javarosa xpath/expr/FunctionUtils.java::toNumeric`): text is
 * NaN, so every ordering with a side held as text is false.
 *
 * "Check" copies the case's `seen` into a hidden value and orders it against
 * `now()` under a clock an hour later on the same day. "Seen before eleven"
 * lists the cases seen before 11:00 UTC that day; "Seen before due" lists the
 * cases whose `seen` is before their `due`.
 *
 * Form logic holds no literal row: Nova refuses a date and time written as
 * text in an ordering (`XPATH_TIME_ORDERING`).
 *
 * Fixed values: Amina was seen at 10:00 and is due at 11:00 on one day, so she
 * is listed by both filters; Baraka was seen at 12:00 and was due at 11:00, so
 * neither lists him.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { datetimeLiteral, lt, prop, term } from "@/lib/domain/predicate";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-datetime-operands";
const uuid = (name: string) => targetedUuid(ID, name);

const VISIT = {
	name: "visit",
	properties: [
		{ name: "case_name", label: proseText("Name") },
		{ name: "due", label: proseText("Due"), data_type: "datetime" as const },
		{ name: "seen", label: proseText("Seen"), data_type: "datetime" as const },
		{ name: "notes", label: proseText("Notes"), data_type: "text" as const },
	],
};

function reviewForm(name: string) {
	return {
		uuid: uuid(`${name}-review`),
		name: "Review",
		type: "followup" as const,
		fields: [
			f({
				kind: "text",
				uuid: uuid(`${name}-review-notes`),
				id: "notes",
				label: proseText("Notes"),
				caseWrite: { caseType: "visit", property: "notes" },
			}),
		],
	};
}

export function datetimeOperands() {
	const check = uuid("check");
	const doc = buildDoc({
		appId: ID,
		appName: "Visit operands",
		caseTypes: [VISIT],
		modules: [
			{
				uuid: uuid("visit-module"),
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: uuid("book"),
						name: "Book",
						type: "registration",
						fields: [
							f({
								kind: "text",
								uuid: uuid("book-name"),
								id: "name",
								label: proseText("Name"),
								caseWrite: { caseType: "visit", property: "case_name" },
							}),
							f({
								kind: "text",
								uuid: uuid("book-notes"),
								id: "notes",
								label: proseText("Notes"),
								caseWrite: { caseType: "visit", property: "notes" },
							}),
						],
					},
					{
						uuid: check,
						name: "Check",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("check-notes"),
								id: "notes",
								label: proseText("Notes"),
								caseWrite: { caseType: "visit", property: "notes" },
							}),
							f({
								kind: "hidden",
								uuid: uuid("check-seen"),
								id: "seen",
								default_value: "#visit/seen",
							}),
							f({
								kind: "hidden",
								uuid: uuid("check-now-order"),
								id: "now_order",
								calculate:
									"if(#form/seen < now(), 'seen before now', 'seen not before now')",
							}),
						],
					},
				],
			},
			{
				uuid: uuid("literal-module"),
				name: "Seen before eleven",
				caseType: "visit",
				caseListConfig: caseListOf(
					[plainColumn(uuid("literal-name"), "case_name", "Name")],
					{
						filter: lt(
							prop("visit", "seen"),
							term(datetimeLiteral("2026-03-01T11:00:00")),
						),
					},
				),
				forms: [reviewForm("literal")],
			},
			{
				uuid: uuid("due-module"),
				name: "Seen before due",
				caseType: "visit",
				caseListConfig: caseListOf(
					[plainColumn(uuid("due-name"), "case_name", "Name")],
					{ filter: lt(prop("visit", "seen"), prop("visit", "due")) },
				),
				forms: [reviewForm("due")],
			},
		],
	});
	const restore = restoreXml({
		cases: [
			{
				id: "targeted-visit-amina",
				type: "visit",
				name: "Amina",
				properties: {
					due: "2026-03-01T11:00:00.000Z",
					seen: "2026-03-01T10:00:00.000Z",
				},
			},
			{
				id: "targeted-visit-baraka",
				type: "visit",
				name: "Baraka",
				properties: {
					due: "2026-03-01T11:00:00.000Z",
					seen: "2026-03-01T12:00:00.000Z",
				},
			},
		],
	});
	const beforeNow = (exportName: "local" | "A") => ({
		id: `seen-before-now-${exportName === "local" ? "local" : "a"}`,
		export: exportName,
		form: check,
		restore: "restore.xml",
		request: {
			session: { command: "m0-f1", data: { case_id: "targeted-visit-amina" } },
			expressions: ["/data/now_order"],
			clock: "2026-03-01T11:00:00.000Z",
		},
		expect: [{ pointer: "/values/0/value", value: "seen before now" }],
	});
	const listed = (id: string, name: string, command: string) => ({
		id,
		export: "local" as const,
		form: uuid(`${name}-review`),
		restore: "restore.xml",
		request: { session: { command }, caseList: {} },
		expect: [
			{ pointer: "/caseList/rows/0/caseId", value: "targeted-visit-amina" },
		],
	});
	return targetedDocument({
		id: ID,
		rows: ["56"],
		doc,
		expected: {
			intent: [
				beforeNow("local"),
				beforeNow("A"),
				listed("listed-before-literal-local", "literal", "m1-f0"),
				listed("listed-before-due-local", "due", "m2-f0"),
			],
		},
		files: { "restore.xml": restore },
	});
}
