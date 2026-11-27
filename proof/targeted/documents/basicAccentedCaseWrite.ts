import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { NEW_APP_SETTINGS, plainColumn, proseText } from "@/lib/domain";
import { formField, term } from "@/lib/domain/expression";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";
import { answerHeld } from "./echo";

export function basicAccentedCaseWrite() {
	const id = "targeted-basic-accented-case-write";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("visit");
	const selected = "proof-member";
	const doc = buildDoc({
		appId: id,
		appName: "Accented case property",
		appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		caseTypes: [
			{
				name: "person",
				properties: ["estado_e", "estado_é"].map((name) => ({
					name,
					label: proseText(name),
					data_type: "text",
				})),
			},
		],
		modules: [
			{
				uuid: uuid("members"),
				name: "Members",
				caseType: "person",
				caseListConfig: caseListOf([
					plainColumn(uuid("name-column"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: uuid("note"),
								kind: "text",
								id: "note",
								label: proseText("Note"),
							}),
						],
					},
				],
			},
		],
	});
	const own = doc.forms[form].caseOperations?.find(
		(one) => one.action === "own",
	);
	if (own === undefined)
		throw new Error("The follow-up has no selected case to write.");
	own.writes = [{ property: "estado_é", value: term(formField(uuid("note"))) }];
	const intent = answerHeld(
		"visit-note",
		form,
		"/data/note",
		"Visit completed",
		"local",
		{
			command: "m0-f0",
			caseId: selected,
		},
	);
	return targetedDocument({
		id,
		doc,
		rows: [
			"forms-and-case-writes/basic-update-key-with-an-accented-latin-name",
		],
		files: {
			"restore.xml": restoreXml({
				cases: [
					{
						id: selected,
						type: "person",
						name: "Selected member",
						properties: { estado_e: "ASCII neighbor", estado_é: "before" },
					},
				],
			}),
		},
		expected: {
			intent: [
				{ ...intent, request: { ...intent.request, restore: "restore.xml" } },
			],
		},
	});
}
