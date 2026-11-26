/** Core, Android and Web Apps read these dates with the proof clock at 15 January 2026. */
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	dateCountColumn,
	formattedTextColumn,
	overdueMarkerColumn,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const id = "targeted-relative-case-dates";
const uuid = (name: string) => targetedUuid(id, name);

export function relativeCaseDates() {
	const form = uuid("visit");
	const doc = buildDoc({
		appId: id,
		appName: "Visit reminders",
		caseTypes: [
			{
				name: "member",
				properties: [
					{ name: "case_name", label: proseText("Name") },
					{ name: "due", label: proseText("Due date"), data_type: "date" },
					{ name: "message", label: proseText("Message") },
				],
			},
		],
		modules: [
			{
				uuid: uuid("members"),
				name: "Members",
				caseType: "member",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
					dateCountColumn(
						uuid("months"),
						"due",
						"Months until",
						"months-until",
					),
					dateCountColumn(uuid("weeks"), "due", "Weeks since", "weeks-since"),
					overdueMarkerColumn(uuid("flag"), "due", "Past due", 0),
					formattedTextColumn(uuid("message"), "message", "Message"),
				]),
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								uuid: uuid("notes"),
								id: "notes",
								label: proseText("Notes"),
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		doc,
		rows: ["Case detail date counts in signed calendar intervals"],
		files: {
			"restore.xml": restoreXml({
				cases: [
					{
						id: "dates-a",
						type: "member",
						name: "Ana",
						properties: { due: "2026-02-15", message: "**Bring** the card" },
					},
					{
						id: "dates-b",
						type: "member",
						name: "Bea",
						properties: { due: "2026-01-14" },
					},
					{ id: "dates-c", type: "member", name: "Cy", properties: {} },
				],
			}),
		},
		expected: {
			intent: [
				{
					id: "calendar-counts",
					export: "local",
					form,
					restore: "restore.xml",
					request: { session: { command: "m0-f0" }, caseList: {} },
					expect: [
						{ pointer: "/caseList/rows/0/caseId", value: "dates-a" },
						{ pointer: "/caseList/rows/0/fields/1", value: "1" },
						{ pointer: "/caseList/rows/0/fields/2", value: "-4" },
						{ pointer: "/caseList/rows/1/fields/1", value: "0" },
						{ pointer: "/caseList/rows/2/fields/1", value: "" },
						{ pointer: "/caseList/rows/0/fields/3", value: "" },
						{
							pointer: "/caseList/rows/0/fields/4",
							value: "**Bring** the card",
						},
						{ pointer: "/caseList/rows/1/fields/3", value: "*" },
						{ pointer: "/caseList/rows/2/fields/3", value: "*" },
					],
				},
			],
		},
	});
}
