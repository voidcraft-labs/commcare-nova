/** Actual exported artifacts. Native execution of the same accepted documents
 * lives in proof/native; these checks cover wire routing. */
import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema } from "@/lib/domain";
import { caseCaptureFixture, caseCaptureScenarios } from "./caseCaptureFixture";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

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
	new SaxesParser({ xmlns: true }).write(xml).close();
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
		it(`${scenario}: writes every capture as a link in the exported form ${withTarget ? "with" : "without"} a published target`, () => {
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
				new AdmZip(
					compileCcz(hq, doc.appName, doc, {
						runtimeTarget: TEST_RUNTIME_TARGET,
					}),
				).readAsText("modules-0/forms-0.xml"),
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
			// Each capture's write names its link sibling, never the upload
			// question HQ's build would turn into an `<attachment>`; with no
			// target there is no link, and the write is withheld.
			for (const [property, capture] of [
				["photo", "thepicture"],
				["scan_url", "scan"],
			] as const)
				expect(update[property]).toEqual(
					withTarget
						? {
								question_path: `${scope}/details/nova_url_${capture}`,
								update_mode: "always",
							}
						: undefined,
				);
			// No preload action: a follow-up's name question opens on the
			// case's name through its own default, written at its place.
			expect(firstForm.actions.case_preload.preload).toEqual({});
			const nameSeeds = (form: { model: Element }) =>
				form.model.children
					.filter(isTag)
					.filter(
						(e) => e.name === "setvalue" && e.attribs.ref === "/data/full_name",
					)
					.map((e) => e.attribs.value);
			for (const form of [source, device])
				expect(nameSeeds(form)).toEqual(
					scenario === "followup"
						? [
								"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/case_name",
							]
						: [],
				);
			for (const form of [source, device]) {
				const details = child(container(form.data), "details");
				expect(details.children.filter(isTag).map((e) => e.name)).toEqual(
					withTarget
						? ["thepicture", "nova_url_thepicture", "scan", "nova_url_scan"]
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
				for (const capture of ["thepicture", "scan"]) {
					const link = `${scope}/details/nova_url_${capture}`;
					if (withTarget) {
						expect(bind(form.model, link)).toEqual({
							nodeset: link,
							type: "xsd:string",
							calculate: `if(${scope}/details/${capture} = '', '', concat('https://www.commcarehq.org/a/demo-project/api/form_attachment/v1/', /data/meta/instanceID, '/', ${scope}/details/${capture}))`,
							relevant: `count(${scope}/details/${capture}) > 0`,
						});
					} else {
						expect(
							findAll(
								(e) =>
									Object.values(e.attribs).some((value) =>
										value.includes(`nova_url_${capture}`),
									),
								form.model.children,
							),
						).toEqual([]);
					}
				}
				expect(
					findAll((e) => e.name === "attachment", form.data.children),
				).toEqual([]);
			}
			// Case/meta lowering belongs to the archive compiler, not a test helper.
			// The archive writes a primary case's `<update>` exactly when the
			// action writes a property, and a child case's always, as HQ's
			// build does.
			const transaction = child(container(device.data), "case");
			const written = [
				...(scenario === "followup" ? ["case_name"] : []),
				...(withTarget ? ["photo", "scan_url"] : []),
			];
			expect(
				transaction.children
					.filter(isTag)
					.filter((e) => e.name === "update")
					.map((e) => e.children.filter(isTag).map((leaf) => leaf.name)),
			).toEqual(written.length === 0 && !repeated ? [] : [written]);
			if (withTarget)
				for (const [property, capture] of [
					["photo", "thepicture"],
					["scan_url", "scan"],
				] as const)
					expect(
						bind(device.model, `${scope}/case/update/${property}`),
					).toEqual({
						nodeset: `${scope}/case/update/${property}`,
						calculate: `${scope}/details/nova_url_${capture}`,
						relevant: `count(${scope}/details/nova_url_${capture}) > 0`,
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
