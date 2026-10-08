/**
 * Defect 20, CommTrack: a form that reads the session's `supply_point_id`.
 *
 * In a project space with CommTrack on, HQ gives a form whose source holds
 * the text `instance('commcaresession')/session/data/supply_point_id` a
 * datum of that id from the worker's `commtrack-supply-point` user data,
 * with assertions that it and its case exist
 * (`suite_xml/sections/entries.py::EntriesHelper.get_userdata_autoselect`),
 * so a worker without one cannot open the form. HQ's test is a substring
 * test on the stored source.
 *
 * Nova's gate admits the read, and Nova's export writes the path's
 * apostrophes as `&apos;`, so the source Nova uploads does not hold HQ's
 * text and HQ gives its form no datum; a save in HQ's form builder writes
 * the apostrophes plainly, and from then HQ's build gives the form the
 * datum (`proof/targeted/__tests__/unproducedInputs.test.ts` holds the
 * spelling). One followup form holds one hidden value that reads the datum,
 * and the document's project space has CommTrack on.
 *
 * Fixed values: with no such datum in the session, the hidden value is
 * blank.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn, proseText } from "@/lib/domain";
import { caseListOf, targetedDocument, targetedUuid } from "../build";
import { restoreXml } from "../restore";

const ID = "targeted-supply-point-read";
const uuid = (name: string) => targetedUuid(ID, name);

/** The path HQ's substring test looks for (`suite_xml/xml_models.py::session_var`). */
export const SUPPLY_POINT_PATH =
	"instance('commcaresession')/session/data/supply_point_id";

export function supplyPointRead() {
	const form = uuid("form");
	const doc = buildDoc({
		appId: ID,
		appName: "Stock visits",
		caseTypes: [
			{
				name: "client",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				uuid: uuid("module"),
				name: "Clients",
				caseType: "client",
				caseListConfig: caseListOf([
					plainColumn(uuid("name"), "case_name", "Name"),
				]),
				forms: [
					{
						uuid: form,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "hidden",
								uuid: uuid("supply-point"),
								id: "supply_point",
								calculate: SUPPLY_POINT_PATH,
							}),
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
	const restore = restoreXml({
		cases: [{ id: "targeted-amina", type: "client", name: "Amina" }],
	});
	return targetedDocument({
		id: ID,
		rows: ["20, CommTrack"],
		doc,
		projectSettings: { commtrack: true },
		expected: {
			intent: [
				{
					id: "no-supply-point-in-the-session",
					export: "local",
					form,
					restore: "restore.xml",
					request: {
						session: {
							command: "m0-f0",
							data: { case_id: "targeted-amina" },
						},
						expressions: ["/data/supply_point"],
					},
					expect: [{ pointer: "/values/0/value", value: "" }],
				},
			],
		},
		files: { "restore.xml": restore },
	});
}
