import AdmZip from "adm-zip";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { describe, expect, it } from "vitest";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import { compileCcz } from "../compiler";
import { expandDoc } from "../expander";
import { runValidation } from "../validator/runner";
import {
	WORKER_PROPERTY,
	workerSlugs,
	workerWireFixture,
} from "./workerWireFixture";

const usercase =
	"instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]";
function elements(xml: string, name: string) {
	return findAll(
		(e) => e.name === name,
		parseDocument(xml, { xmlMode: true }).children,
	);
}
describe("worker property wire projection", () => {
	it.each(workerSlugs)(
		"joins admitted %s identities to distinct menu and XForm runtime sources",
		(slug) => {
			const { doc } = workerWireFixture(slug),
				before = structuredClone(doc),
				hq = expandDoc(doc),
				zip = new AdmZip(compileCcz(hq, doc.appName, doc));
			const menuCondition = `instance('commcaresession')/session/user/data/${slug} = 'n'`;
			expect(hq.modules[0].module_filter).toBe(menuCondition);
			const menu = elements(zip.readAsText("suite.xml"), "menu").find(
				(e) => e.attribs.id === "m0",
			);
			expect(menu?.attribs.relevant).toBe(menuCondition);
			expect(
				menu?.children.some(
					(e) => "attribs" in e && e.attribs.id === "commcaresession",
				),
			).toBe(true);
			for (const xml of [
				Object.values(hq._attachments)[0],
				zip.readAsText("modules-0/forms-0.xml"),
			]) {
				expect(
					elements(xml, "bind").find(
						(e) => e.attribs.nodeset === "/data/supervisor_note",
					)?.attribs.relevant,
				).toBe(`${usercase}/${slug} = 'n'`);
				expect(
					elements(xml, "instance")
						.filter((e) => e.attribs.src)
						.map((e) => e.attribs.id)
						.sort(),
				).toEqual(["casedb", "commcaresession"]);
			}
			expect(doc).toEqual(before);
		},
	);
	it("changes emitted spelling while both stored AST objects retain identity", () => {
		const { doc, moduleUuid, fieldUuid } = workerWireFixture();
		const field = doc.fields[fieldUuid];
		if (field.kind !== "text") throw new Error("Expected text field");
		const predicate = doc.modules[moduleUuid].displayCondition,
			xpath = field.relevant;
		const properties = doc.userProperties;
		if (!properties) throw new Error("Missing worker catalog");
		properties[WORKER_PROPERTY].slug = "supervision_status";
		blueprintDocSchema.parse(toPersistableDoc(doc));
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const hq = expandDoc(doc);
		expect(doc.modules[moduleUuid].displayCondition).toBe(predicate);
		expect(field.relevant).toBe(xpath);
		expect(hq.modules[0].module_filter).toBe(
			"instance('commcaresession')/session/user/data/supervision_status = 'n'",
		);
		expect(
			elements(Object.values(hq._attachments)[0], "bind").find(
				(e) => e.attribs.nodeset === "/data/supervisor_note",
			)?.attribs.relevant,
		).toBe(`${usercase}/supervision_status = 'n'`);
	});
});
