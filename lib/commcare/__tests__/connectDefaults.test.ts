import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { findAll, textContent } from "domutils";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { describe, expect, it } from "vitest";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { blueprintDocSchema, proseText } from "@/lib/domain";
import { term } from "@/lib/domain/expression/builders";
import { connectWireFixtures } from "./connectWireFixtures";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";
import { xpathEvidence } from "./xpathEvidence";

function one(elements: Element[]): Element {
	expect(elements).toHaveLength(1);
	return elements[0];
}

// Connect opportunity/app_xml.py::extract_modules/extract_deliver_unit/
// extract_task_unit consumes namespace-qualified children. Core owns calculation
// execution; ConnectRuntimeTest consumes these same admitted documents.
interface ExpectedBlock {
	id: string;
	role: string;
	tag: string;
	values: Record<string, string>;
}

/** The Connect blocks each form of a scenario's one menu holds, in order. A
 *  deliver app's task sits in a form of its own, after the deliver form. */
function expectedBlocks(name: string): ExpectedBlock[][] {
	if (name === "absent") return [[]];
	if (name.startsWith("learn"))
		return [
			[
				{
					id: "lesson",
					role: "ConnectLearnModule",
					tag: "module",
					values: {
						name: "Health & care <雪>",
						description: "Read 'A' then \"B\"",
						time_estimate: "5",
					},
				},
				{
					id: "quiz",
					role: "ConnectAssessment",
					tag: "assessment",
					values: { user_score: "" },
				},
			],
		];
	return [
		[
			{
				id: "visit",
				role: "ConnectDeliverUnit",
				tag: "deliver",
				// The empty work area id follows the entity name, as
				// HQ's form builder writes a deliver unit.
				values: {
					name: "Home & clinic <雪>",
					entity_id: "",
					entity_name: "",
					work_area_id: "",
				},
			},
		],
		[
			{
				id: "follow_up",
				role: "ConnectTask",
				tag: "task",
				values: {
					name: "Record & review",
					description: "Ask <then> listen",
				},
			},
		],
	];
}

/** The first form's Connect value binds, including the uncalculated work area. */
function expectedCalculations(
	name: string,
): Record<string, string | undefined> {
	if (name.startsWith("learn"))
		return {
			"/data/quiz/assessment/user_score": name.endsWith("custom")
				? "/data/score"
				: "100",
		};
	if (name === "absent") return {};
	return {
		"/data/visit/deliver/entity_id": name.endsWith("custom")
			? "concat('visit-', /data/score)"
			: "concat(instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/username, '-', today())",
		"/data/visit/deliver/entity_name": name.endsWith("custom")
			? "/data/feedback"
			: "instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/username",
		"/data/visit/deliver/work_area_id": undefined,
	};
}

function calculationEvidence(
	calculations: Readonly<Record<string, string | undefined>>,
) {
	return Object.fromEntries(
		Object.entries(calculations).map(([path, expression]) => [
			path,
			expression === undefined ? undefined : xpathEvidence(expression),
		]),
	);
}

// Connect opportunity/app_xml.py::extract_modules/extract_deliver_unit/
// extract_task_unit consumes namespace-qualified children. Core owns calculation
// execution; ConnectRuntimeTest consumes these same admitted documents.
describe("Connect blocks in delivered forms", () => {
	it.each(connectWireFixtures())(
		"$name preserves identities, metadata, binds and instance dependencies",
		({ name, doc }) => {
			const before = structuredClone(doc);
			const hq = expandDoc(doc);
			const archive = new AdmZip(
				compileCcz(hq, doc.appName, doc, {
					runtimeTarget: TEST_RUNTIME_TARGET,
				}),
			);
			const blocksByForm = expectedBlocks(name);
			expect(hq.modules[0].forms).toHaveLength(blocksByForm.length);
			for (const [formIndex, expected] of blocksByForm.entries()) {
				const hqForm = hq.modules[0].forms[formIndex];
				expect(hqForm.case_references_data.load).toEqual(
					name === "deliver-default" && formIndex === 0
						? {
								"/data/visit/deliver/entity_id": ["#user/username"],
								"/data/visit/deliver/entity_name": ["#user/username"],
							}
						: {},
				);
				for (const [delivery, xml] of [
					["hq-source", hq._attachments[`${hqForm.unique_id}.xml`]],
					["ccz", archive.readAsText(`modules-0/forms-${formIndex}.xml`)],
				]) {
					if (typeof xml !== "string") throw new Error("Missing emitted form");
					new SaxesParser({ xmlns: true }).write(xml).close();
					const tree = parseDocument(xml, { xmlMode: true });
					const model = one(findAll((e) => e.name === "model", tree.children));
					const instance = one(
						model.children
							.filter(isTag)
							.filter((e) => e.name === "instance" && !e.attribs.id),
					);
					const data = one(instance.children.filter(isTag));
					const blocks = data.children
						.filter(isTag)
						.filter((e) =>
							e.children
								.filter(isTag)
								.some(
									(child) =>
										child.attribs.xmlns ===
										"http://commcareconnect.com/data/v1/learn",
								),
						);
					expect(blocks.map((e) => e.name)).toEqual(expected.map((e) => e.id));
					for (const [i, block] of expected.entries()) {
						expect(blocks[i].attribs["vellum:role"]).toBe(
							delivery === "hq-source" ? block.role : undefined,
						);
						const inner = one(blocks[i].children.filter(isTag));
						expect({
							tag: inner.name,
							attributes: inner.attribs,
							values: Object.fromEntries(
								inner.children
									.filter(isTag)
									.map((e) => [e.name, textContent(e)]),
							),
						}).toEqual({
							tag: block.tag,
							attributes: {
								xmlns: "http://commcareconnect.com/data/v1/learn",
								id: block.id,
							},
							values: block.values,
						});
						expect(inner.children.filter(isTag).map((e) => e.name)).toEqual(
							Object.keys(block.values),
						);
						const wrapperBind = one(
							model.children
								.filter(isTag)
								.filter(
									(e) =>
										e.name === "bind" &&
										e.attribs.nodeset === `/data/${block.id}`,
								),
						);
						expect(wrapperBind.attribs["vellum:nodeset"]).toBe(
							delivery === "hq-source" ? `#form/${block.id}` : undefined,
						);
					}
					const calculated = Object.fromEntries(
						model.children
							.filter(isTag)
							.filter(
								(e) =>
									e.name === "bind" &&
									/^\/data\/(quiz|visit)\//.test(e.attribs.nodeset ?? ""),
							)
							.map((e) => [e.attribs.nodeset, e.attribs.calculate]),
					);
					expect(calculationEvidence(calculated)).toStrictEqual(
						calculationEvidence(
							formIndex === 0 ? expectedCalculations(name) : {},
						),
					);
					if (name === "deliver-default" && formIndex === 0)
						expect(
							model.children
								.filter(isTag)
								.filter(
									(e) =>
										e.name === "instance" && e.attribs.id === "commcaresession",
								)
								.map((e) => e.attribs.src),
						).toEqual(["jr://instance/session"]);
				}
			}
			expect(doc).toEqual(before);
		},
	);
});

it("joins case-backed Connect calculations and HQ dependency paths to the selected case", () => {
	const scenario = connectWireFixtures().find(
		(fixture) => fixture.name === "deliver-default",
	);
	if (!scenario) throw new Error("Missing deliver fixture");
	const doc = structuredClone(scenario.doc);
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	doc.caseTypes = [
		{
			name: "visit",
			properties: [
				{ name: "beneficiary_id", label: proseText("Beneficiary") },
				{ name: "case_name", label: proseText("Name") },
			],
		},
	];
	doc.modules[moduleUuid].caseType = "visit";
	doc.modules[moduleUuid].caseListConfig = caseListConfig([
		{ field: "case_name", header: "Name" },
	]);
	doc.forms[formUuid].type = "followup";
	doc.forms[formUuid].connect = {
		deliver_unit: {
			id: "vendor_visit",
			name: "Visit",
			entity_id: term({
				kind: "form-case",
				caseType: "visit",
				property: "beneficiary_id",
			}),
			entity_name: term({
				kind: "form-case",
				caseType: "visit",
				property: "case_name",
			}),
		},
	};
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const hq = expandDoc(doc);
	expect(hq.modules[0].forms[0].case_references_data.load).toEqual({
		"/data/vendor_visit/deliver/entity_id": ["#case/beneficiary_id"],
		"/data/vendor_visit/deliver/entity_name": ["#case/case_name"],
	});
	const xml = hq._attachments[`${hq.modules[0].forms[0].unique_id}.xml`];
	new SaxesParser({ xmlns: true }).write(xml).close();
	const tree = parseDocument(xml, { xmlMode: true });
	const model = one(
		findAll((element) => element.name === "model", tree.children),
	);
	const binds = model.children
		.filter(isTag)
		.filter(
			(element) =>
				element.name === "bind" &&
				element.attribs.nodeset.startsWith("/data/vendor_visit/deliver/"),
		);
	expect(
		binds.map((element) => [
			element.attribs.nodeset,
			element.attribs.calculate,
		]),
	).toEqual([
		[
			"/data/vendor_visit/deliver/entity_id",
			"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/beneficiary_id",
		],
		[
			"/data/vendor_visit/deliver/entity_name",
			"instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/case_name",
		],
		["/data/vendor_visit/deliver/work_area_id", undefined],
	]);
	// The work area id's bind names its node alone, as HQ's form builder
	// writes it.
	expect(binds.at(-1)?.attribs).toEqual({
		nodeset: "/data/vendor_visit/deliver/work_area_id",
	});
});
