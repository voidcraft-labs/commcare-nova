/**
 * A date and time saved to a case, written as CommCare HQ stores it.
 *
 * CommCare HQ rewrites every date and time a submission holds to UTC with
 * six fraction digits and `Z` (`form_processor/utils/xform.py::adjust_datetimes`),
 * while a phone keeps the text it wrote, and a list orders such a property
 * as text (`EntitySorter.java::getCmp`). Nova writes CommCare HQ's own text
 * on the phone (`lib/commcare/xform/datetimeCaseValue.ts::datetimeCaseValue`),
 * so the phone, CommCare HQ and every other phone hold one text.
 *
 * `targeted-datetime-saved` is one menu of visits. "Book" asks a date and
 * time and saves it to `seen_at` through Case Management. "Check" asks a date
 * and time and whether to keep it, and holds one more change of the visit,
 * a Save to Case block whose rows write the answer (`checked_at`), `now()`
 * (`stamped_at`), a copy of the saved `seen_at` (`seen_copy`), and an `if`
 * that chooses between the answer and the stored text (`chosen_at`). Each
 * row's calculate is the long one `datetimeCaseValue` prints, which two
 * saves in CommCare HQ's form builder must keep; what a phone then stores in
 * every device zone is `proof/native/core/StoredInstantRuntimeTest.java`'s.
 * The list orders by `seen_at` ascending.
 *
 * The document declares Android only: a date-and-time question has no entry
 * in Web Apps (the platform row `datetime-question`), where Nova asks for a
 * date and a time joined in a Hidden Value instead.
 *
 * Fixed values: the restore holds three visits whose `seen_at` is in
 * CommCare HQ's spelling, Baraka at 2026-01-02T09:30, Amani at
 * 2026-01-01T23:15 and Chiku at 2026-01-02T01:00, all UTC, so the list reads
 * Amani, Chiku, Baraka, the order of the moments.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseOperation,
	columnSort,
	NEW_APP_SETTINGS,
	plainColumn,
	proseText,
} from "@/lib/domain";
import {
	eq,
	formField,
	ifExpr,
	literal,
	now,
	prop,
	term,
} from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-datetime-saved";
const uuid = (name: string) => targetedUuid(ID, name);

export function datetimeSaved() {
	const book = uuid("book");
	const check = uuid("check");
	const when = uuid("check-when");
	const keep = uuid("check-keep");
	// The visit's saved `seen_at`, read on the case the form opened.
	const saved = term(prop("visit", "seen_at"));
	const datetime = (name: string, label: string) => ({
		name,
		label: proseText(label),
		data_type: "datetime" as const,
	});
	const built = buildDoc({
		appId: ID,
		appName: "Visit times",
		// A date-and-time question runs on Android alone.
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					datetime("seen_at", "Seen at"),
					datetime("checked_at", "Checked at"),
					datetime("stamped_at", "Stamped at"),
					datetime("seen_copy", "Seen copy"),
					datetime("chosen_at", "Chosen at"),
				],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Visits",
				caseType: "visit",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
					plainColumn(uuid("seen"), "seen_at", "Seen at", {
						sort: columnSort("asc", 0),
					}),
				]),
				forms: [
					{
						uuid: book,
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
								kind: "datetime",
								uuid: uuid("book-seen"),
								id: "seen",
								label: proseText("Seen at"),
								caseWrite: { caseType: "visit", property: "seen_at" },
							}),
						],
					},
					{
						uuid: check,
						name: "Check",
						type: "followup",
						fields: [
							f({
								kind: "datetime",
								uuid: when,
								id: "when",
								label: proseText("Checked at"),
							}),
							f({
								kind: "text",
								uuid: keep,
								id: "keep",
								label: proseText("Keep this time? yes or no"),
							}),
						],
					},
				],
			},
		],
	});
	const operation: CaseOperation = {
		uuid: uuid("check-operation"),
		id: "stamp_visit",
		action: "update",
		caseType: "visit",
		target: { kind: "session" },
		writes: [
			{ property: "checked_at", value: term(formField(when)) },
			{ property: "stamped_at", value: now() },
			{ property: "seen_copy", value: saved },
			{
				property: "chosen_at",
				value: ifExpr(
					eq(term(formField(keep)), literal("yes")),
					term(formField(when)),
					saved,
				),
			},
		],
	};
	const doc: BlueprintDoc = {
		...built,
		forms: {
			...built.forms,
			[check]: {
				...built.forms[check],
				caseOperations: [
					...(built.forms[check].caseOperations ?? []),
					operation,
				],
			},
		},
	};
	const restore = restoreXml({
		cases: [
			{
				id: "targeted-baraka",
				type: "visit",
				name: "Baraka",
				properties: { seen_at: "2026-01-02T09:30:00.000000Z" },
			},
			{
				id: "targeted-amani",
				type: "visit",
				name: "Amani",
				properties: { seen_at: "2026-01-01T23:15:00.000000Z" },
			},
			{
				id: "targeted-chiku",
				type: "visit",
				name: "Chiku",
				properties: { seen_at: "2026-01-02T01:00:00.000000Z" },
			},
		],
	});
	return targetedDocument({
		id: ID,
		rows: [
			"forms-and-case-writes, a date and time saved to a case as CommCare HQ stores it",
		],
		doc,
		expected: {
			intent: [
				{
					id: "list-ordered-by-moment",
					export: "local",
					form: check,
					restore: "restore.xml",
					request: {
						session: { command: "m0-f1" },
						caseList: {},
					},
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "targeted-amani" },
						{ pointer: "/caseList/rows/1/caseId", value: "targeted-chiku" },
						{ pointer: "/caseList/rows/2/caseId", value: "targeted-baraka" },
					],
				},
			],
		},
		files: { "restore.xml": restore },
	});
}
