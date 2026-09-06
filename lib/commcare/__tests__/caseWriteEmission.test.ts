import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { XMLValidator } from "fast-xml-parser";
import { parseDocument } from "htmlparser2";
import { expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type BlueprintDoc, blueprintDocSchema, proseText } from "@/lib/domain";

function one(elements: Element[]) {
	expect(elements).toHaveLength(1);
	const element = elements[0];
	if (!element) throw new Error("Missing exported element");
	return element;
}
function child(element: Element, name: string): Element {
	return one(element.children.filter(isTag).filter((e) => e.name === name));
}
function read(xml: string) {
	expect(XMLValidator.validate(xml)).toBe(true);
	const root = one(
		parseDocument(xml, { xmlMode: true }).children.filter(isTag),
	);
	const model = child(child(root, "h:head"), "model");
	const nodes = model.children.filter(isTag);
	const data = child(
		one(nodes.filter((e) => e.name === "instance" && !e.attribs.src)),
		"data",
	);
	return {
		data,
		bind: (nodeset: string) =>
			one(
				nodes.filter((e) => e.name === "bind" && e.attribs.nodeset === nodeset),
			).attribs,
		seeds: nodes.filter((e) => e.name === "setvalue"),
	};
}
function exported(doc: BlueprintDoc) {
	expect(blueprintDocSchema.safeParse(toPersistableDoc(doc)).success).toBe(
		true,
	);
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const hq = expandDoc(doc);
	const form = hq.modules[0].forms[0];
	const source = hq._attachments[`${form.unique_id}.xml`];
	if (typeof source !== "string") throw new Error("Missing HQ source");
	const zip = new AdmZip(compileCcz(hq, doc.appName, doc));
	return {
		actions: form.actions,
		source: read(source),
		local: read(zip.readAsText("modules-0/forms-0.xml")),
	};
}

// Export facts are asserted against actual nodes and complete bind attributes.
// This is not native HQ execution: that evidence belongs in scripts/fixtures/hq.
it.each(["registration", "followup"] as const)(
	"keeps the case destination through a real question rename and group move (%s)",
	(type) => {
		let doc = buildDoc({
			appName: "Issue reports",
			caseTypes: [
				{
					name: "issue",
					properties: [
						{ name: "case_name", label: proseText("Issue") },
						{ name: "issue_description", label: proseText("Description") },
					],
				},
			],
			modules: [
				{
					name: "Issues",
					caseType: "issue",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Issue" },
					]),
					forms: [
						{
							name: "Report",
							type,
							fields: [
								f({
									kind: "text",
									id: "subject",
									caseWrite: { caseType: "issue", property: "case_name" },
								}),
								f({
									kind: "group",
									id: "left",
									children: [
										f({
											kind: "text",
											id: "description",
											caseWrite: {
												caseType: "issue",
												property: "issue_description",
											},
										}),
									],
								}),
								f({
									kind: "group",
									id: "right",
									children: [f({ kind: "text", id: "description" })],
								}),
							],
						},
					],
				},
			],
		});
		const formUuid = doc.formOrder[doc.moduleOrder[0]][0];
		const [, left, right] = doc.fieldOrder[formUuid];
		const writerUuid = doc.fieldOrder[left][0];
		for (const [phase, path] of [
			["before", "/data/left/description"],
			["after", "/data/right/current_description"],
		] as const) {
			if (phase === "after") {
				const verdict = mutationCommitVerdict(
					doc,
					[
						{
							kind: "updateField",
							targetKind: "text",
							uuid: writerUuid,
							patch: { id: "current_description" },
						},
						{
							kind: "moveField",
							uuid: writerUuid,
							toParentUuid: right,
							after: null,
						},
					],
					LOOKUP_CONTEXT_UNAVAILABLE,
				);
				expect(verdict.ok).toBe(true);
				doc = verdict.nextDoc;
			}
			const output = exported(doc);
			expect(doc.fields[writerUuid]).toMatchObject({
				uuid: writerUuid,
				caseWrite: { caseType: "issue", property: "issue_description" },
			});
			expect(output.actions.update_case.update).toEqual({
				issue_description: { question_path: path, update_mode: "always" },
				...(type === "followup" && {
					name: { question_path: "/data/subject", update_mode: "always" },
				}),
			});
			for (const tree of [output.source, output.local]) {
				// Two same-named cousin answers exist initially. The write must select the
				// actual writer, not the first matching leaf found during a document scan.
				expect(child(child(tree.data, "right"), "description").name).toBe(
					"description",
				);
				expect(
					child(
						child(tree.data, phase === "before" ? "left" : "right"),
						phase === "before" ? "description" : "current_description",
					).name,
				).toBe(phase === "before" ? "description" : "current_description");
			}
			const block = child(output.local.data, "case");
			const updates = child(block, "update")
				.children.filter(isTag)
				.map((e) => e.name);
			expect(updates).toEqual(
				type === "registration"
					? ["issue_description"]
					: ["case_name", "issue_description"],
			);
			expect(output.local.bind("/data/case/update/issue_description")).toEqual({
				nodeset: "/data/case/update/issue_description",
				calculate: path,
				relevant: `count(${path}) > 0`,
			});
			const namePath =
				type === "registration"
					? "/data/case/create/case_name"
					: "/data/case/update/case_name";
			expect(output.local.bind(namePath)).toEqual({
				nodeset: namePath,
				calculate:
					"replace(/data/subject, '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')",
				constraint: "string-length(.) > 0 and string-length(.) <= 255",
				...(type === "followup" && { relevant: "count(/data/subject) > 0" }),
			});
			if (type === "followup") {
				expect(output.actions.case_preload.preload).toEqual({
					"/data/subject": "name",
					[path]: "issue_description",
				});
				expect(
					one(output.local.seeds.filter((e) => e.attribs.ref === path)).attribs,
				).toEqual({
					ref: path,
					event: "xforms-ready",
					value:
						"instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/case_id]/issue_description",
				});
			}
		}
	},
);
