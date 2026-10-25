/**
 * Finding 56's witness: an ordering comparison on a date and time orders by
 * instant on a device.
 *
 * Core compares both sides of an ordering as numbers
 * (`commcare-core javarosa xpath/expr/FunctionUtils.java::toNumeric`): a
 * typed `Date` (a datetime answer) becomes its day count, so two answers an
 * hour apart on one day are not ordered by it, and a date and time held as
 * text (a hidden value seeded from a case property) is NaN, so every bare
 * ordering over it is false. Nova lowers each side by how it is held
 * (`lib/commcare/xpath/wire/instant.ts`): the typed answer through its own
 * text with the device's offset, the held text as itself, each parsed to
 * integer microseconds, so both forms order the two moments. The control
 * `targeted-datetime-ordering` keeps the bare bytes, where the fixed entries
 * of finding 56 still show.
 *
 * "Visit instants" orders two datetime answers, the typed row. "Check" orders
 * two hidden values seeded from the case's `seen` and `due`, the text row.
 * "Book" writes both properties, so HQ knows them, its writers in name order.
 *
 * The document declares Android only, where a device has a widget for a date
 * and time question and Formplayer's walk answers it as Core's session does;
 * its control keeps the form an app declaring Web Apps held, where the
 * client's placeholder stops the walk at the submit (finding 74's stop, held
 * on the control in `proof/walk-stops.json`).
 *
 * Fixed values: the visit starts at 10:00 and ends at 11:00 on one day, so
 * the start is before the end; the case was seen a day before it is due.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { NEW_APP_SETTINGS, plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-datetime-ordering";
const uuid = (name: string) => targetedUuid(ID, name);

export function datetimeOrdering() {
	const instants = uuid("instants");
	const check = uuid("check");
	const doc = buildDoc({
		appId: ID,
		appName: "Visit instants",
		// A date-and-time question runs on Android alone.
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "due", label: proseText("Due"), data_type: "datetime" },
					{ name: "seen", label: proseText("Seen"), data_type: "datetime" },
					{ name: "notes", label: proseText("Notes"), data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: uuid("survey-module"),
				name: "Instants",
				forms: [
					{
						uuid: instants,
						name: "Visit instants",
						type: "survey",
						fields: [
							f({
								kind: "datetime",
								uuid: uuid("start"),
								id: "start",
								label: proseText("Start"),
							}),
							f({
								kind: "datetime",
								uuid: uuid("end"),
								id: "end",
								label: proseText("End"),
							}),
							f({
								kind: "hidden",
								uuid: uuid("instants-order"),
								id: "order",
								calculate:
									"if(#form/start < #form/end, 'start before end', 'start not before end')",
							}),
						],
					},
				],
			},
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
								kind: "datetime",
								uuid: uuid("book-due"),
								id: "due",
								label: proseText("Due"),
								caseWrite: { caseType: "visit", property: "due" },
							}),
							f({
								kind: "datetime",
								uuid: uuid("book-seen"),
								id: "seen",
								label: proseText("Seen"),
								caseWrite: { caseType: "visit", property: "seen" },
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
								uuid: uuid("check-due"),
								id: "due",
								default_value: "#visit/due",
							}),
							f({
								kind: "hidden",
								uuid: uuid("check-order"),
								id: "order",
								calculate:
									"if(#form/seen < #form/due, 'seen before due', 'seen not before due')",
							}),
						],
					},
				],
			},
		],
	});
	const restore = restoreXml({
		cases: [
			{
				id: "targeted-visit",
				type: "visit",
				name: "Amina",
				properties: {
					due: "2026-03-02T10:00:00.000Z",
					seen: "2026-03-01T10:00:00.000Z",
				},
			},
		],
	});
	const startBeforeEnd = (exportName: "local" | "A") => ({
		id: `start-before-end-${exportName === "local" ? "local" : "a"}`,
		export: exportName,
		form: instants,
		request: {
			answers: [
				{ path: "/data/start", value: "2026-03-01T10:00:00.000Z" },
				{ path: "/data/end", value: "2026-03-01T11:00:00.000Z" },
			],
			expressions: ["/data/order"],
		},
		expect: [
			{ pointer: "/answers/0/result", value: "ok" },
			{ pointer: "/answers/1/result", value: "ok" },
			{ pointer: "/values/0/value", value: "start before end" },
		],
	});
	const seenBeforeDue = (exportName: "local" | "A") => ({
		id: `seen-before-due-${exportName === "local" ? "local" : "a"}`,
		export: exportName,
		form: check,
		restore: "restore.xml",
		request: {
			session: { command: "m1-f1", data: { case_id: "targeted-visit" } },
			expressions: ["/data/order"],
		},
		expect: [{ pointer: "/values/0/value", value: "seen before due" }],
	});
	return targetedDocument({
		id: ID,
		rows: ["56"],
		doc,
		expected: {
			intent: [
				startBeforeEnd("local"),
				startBeforeEnd("A"),
				seenBeforeDue("local"),
				seenBeforeDue("A"),
			],
		},
		files: { "restore.xml": restore },
	});
}
