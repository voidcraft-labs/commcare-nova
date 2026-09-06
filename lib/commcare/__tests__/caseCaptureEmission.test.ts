/** Actual exported artifacts. Native execution of the same accepted documents
 * lives in scripts/fixtures/{hq,javarosa}; these checks cover wire routing. */
import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll } from "domutils";
import { XMLValidator } from "fast-xml-parser";
import { parseDocument } from "htmlparser2";
import { expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import { caseCaptureFixture, caseCaptureScenarios } from "./caseCaptureFixture";

function one(elements: Element[]): Element {
	expect(elements).toHaveLength(1);
	const element = elements[0];
	if (!element) throw new Error("Expected one XML element");
	return element;
}
function child(parent: Element, name: string): Element {
	return one(
		parent.children.filter(isTag).filter((element) => element.name === name),
	);
}
function formTree(xml: string) {
	expect(XMLValidator.validate(xml)).toBe(true);
	const html = one(
		parseDocument(xml, { xmlMode: true }).children.filter(isTag),
	);
	const model = child(child(html, "h:head"), "model");
	const instance = one(
		model.children
			.filter(isTag)
			.filter((e) => e.name === "instance" && e.attribs.src === undefined),
	);
	return { model, data: child(instance, "data"), body: child(html, "h:body") };
}
function bind(model: Element, path: string) {
	return one(
		model.children
			.filter(isTag)
			.filter((e) => e.name === "bind" && e.attribs.nodeset === path),
	).attribs;
}
const target = { origin: "https://www.commcarehq.org", domain: "demo-project" };

for (const scenario of caseCaptureScenarios) {
	for (const withTarget of [true, false]) {
		it(`${scenario}: routes file and URL writes in the exported form ${withTarget ? "with" : "without"} a published target`, () => {
			const doc = caseCaptureFixture(scenario);
			expect(blueprintDocSchema.safeParse(toPersistableDoc(doc)).success).toBe(
				true,
			);
			expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
			const hq = expandDoc(
				doc,
				withTarget ? { attachmentTarget: target } : undefined,
			);
			const firstForm = hq.modules[0].forms[0];
			const sourceXml = hq._attachments[`${firstForm.unique_id}.xml`];
			if (typeof sourceXml !== "string") throw new Error("Missing source form");
			const source = formTree(sourceXml);
			const device = formTree(
				new AdmZip(compileCcz(hq, doc.appName, doc)).readAsText(
					"modules-0/forms-0.xml",
				),
			);
			const repeated = scenario === "repeat" || scenario === "query";
			const scope =
				scenario === "query"
					? "/data/wounds/item"
					: scenario === "repeat"
						? "/data/wounds"
						: "/data";
			const container = (data: Element) =>
				scenario === "query"
					? child(child(data, "wounds"), "item")
					: scenario === "repeat"
						? child(data, "wounds")
						: data;
			const update = repeated
				? firstForm.actions.subcases[0].case_properties
				: firstForm.actions.update_case.update;
			expect(update.photo).toEqual({
				question_path: `${scope}/details/thepicture`,
				update_mode: "always",
			});
			expect(update.scan_url).toEqual(
				withTarget
					? {
							question_path: `${scope}/details/__nova_url_scan`,
							update_mode: "always",
						}
					: undefined,
			);
			expect(firstForm.actions.case_preload.preload).toEqual(
				scenario === "followup" ? { "/data/full_name": "name" } : {},
			);
			for (const form of [source, device]) {
				const details = child(container(form.data), "details");
				expect(details.children.filter(isTag).map((e) => e.name)).toEqual(
					withTarget
						? ["thepicture", "scan", "__nova_url_scan"]
						: ["thepicture", "scan"],
				);
				expect(
					findAll((e) => e.name === "upload", form.body.children).map(
						(e) => e.attribs,
					),
				).toEqual([
					{ ref: `${scope}/details/thepicture`, mediatype: "image/*" },
					{ ref: `${scope}/details/scan`, mediatype: "application/*,text/*" },
				]);
				if (withTarget) {
					expect(bind(form.model, `${scope}/details/__nova_url_scan`)).toEqual({
						nodeset: `${scope}/details/__nova_url_scan`,
						type: "xsd:string",
						calculate: `if(${scope}/details/scan = '', '', concat('https://www.commcarehq.org/a/demo-project/api/form_attachment/v1/', /data/meta/instanceID, '/', ${scope}/details/scan))`,
						relevant: `count(${scope}/details/scan) > 0`,
					});
				} else {
					expect(
						findAll(
							(e) =>
								Object.values(e.attribs).some((value) =>
									value.includes("__nova_url_scan"),
								),
							form.model.children,
						),
					).toEqual([]);
				}
			}
			// Case/meta lowering belongs to the archive compiler, not a test helper.
			const transaction = child(container(device.data), "case");
			expect(
				child(transaction, "attachment")
					.children.filter(isTag)
					.map((e) => ({ name: e.name, attributes: e.attribs })),
			).toEqual([{ name: "photo", attributes: { src: "", from: "local" } }]);
			expect(
				child(transaction, "update")
					.children.filter(isTag)
					.map((e) => e.name),
			).toEqual([
				...(scenario === "followup" ? ["case_name"] : []),
				...(withTarget ? ["scan_url"] : []),
			]);
			expect(bind(device.model, `${scope}/case/attachment/photo`)).toEqual({
				nodeset: `${scope}/case/attachment/photo`,
				relevant: `count(${scope}/details/thepicture) = 1`,
			});
			expect(bind(device.model, `${scope}/case/attachment/photo/@src`)).toEqual(
				{
					nodeset: `${scope}/case/attachment/photo/@src`,
					calculate: `${scope}/details/thepicture`,
				},
			);
			if (withTarget)
				expect(bind(device.model, `${scope}/case/update/scan_url`)).toEqual({
					nodeset: `${scope}/case/update/scan_url`,
					calculate: `${scope}/details/__nova_url_scan`,
					relevant: `count(${scope}/details/__nova_url_scan) > 0`,
				});
			const meta = child(device.data, "orx:meta");
			child(meta, "orx:instanceID");
			expect(
				one(
					device.model.children
						.filter(isTag)
						.filter(
							(e) =>
								e.name === "setvalue" &&
								e.attribs.ref === "/data/meta/instanceID",
						),
				).attribs,
			).toEqual({
				ref: "/data/meta/instanceID",
				value: "uuid()",
				event: "xforms-ready",
			});
			if (repeated) {
				const parent = child(device.data, "case");
				expect(parent.children.filter(isTag)).toEqual([]);
				expect(bind(device.model, "/data/case/@case_id")).toEqual({
					nodeset: "/data/case/@case_id",
					calculate: "instance('commcaresession')/session/data/case_id",
				});
				expect(bind(device.model, `${scope}/case/index/parent`)).toEqual({
					nodeset: `${scope}/case/index/parent`,
					calculate: "/data/case/@case_id",
				});
			}
		});
	}
}
