import { type Element, isTag } from "domhandler";
import { XMLValidator } from "fast-xml-parser";
import { parseDocument } from "htmlparser2";
import { expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	alwaysCondition,
	emptyFormActions,
	type FormActionCondition,
	ifCondition,
	neverCondition,
	type OpenSubCaseAction,
} from "@/lib/commcare";
import { buildXForm } from "@/lib/commcare/xform/builder";
import { addCaseBlocks } from "@/lib/commcare/xform/caseBlocks";
import { addMetaBlock } from "@/lib/commcare/xform/metaBlock";

function one(nodes: Element[]): Element {
	expect(nodes).toHaveLength(1);
	const node = nodes[0];
	if (!node) throw new Error("Missing case-wire element");
	return node;
}
function child(parent: Element, name: string): Element {
	return one(parent.children.filter(isTag).filter((e) => e.name === name));
}
function read(xml: string) {
	expect(XMLValidator.validate(xml)).toBe(true);
	const html = one(
		parseDocument(xml, { xmlMode: true }).children.filter(isTag),
	);
	const model = child(child(html, "h:head"), "model");
	const data = child(
		one(
			model.children
				.filter(isTag)
				.filter((e) => e.name === "instance" && !e.attribs.src),
		),
		"data",
	);
	const modelNodes = model.children.filter(isTag);
	return {
		data,
		modelNodes,
		bind: (path: string) =>
			one(
				modelNodes.filter(
					(e) => e.name === "bind" && e.attribs.nodeset === path,
				),
			).attribs,
		seed: (path: string) =>
			one(
				modelNodes.filter(
					(e) => e.name === "setvalue" && e.attribs.ref === path,
				),
			).attribs,
	};
}
function host() {
	const doc = buildDoc({
		modules: [
			{
				name: "Questions",
				forms: [
					{
						name: "Record",
						type: "survey",
						fields: [
							"patient_name",
							"child_name",
							"weight",
							"assigned_owner",
							"done",
						].map((id) => f({ kind: "text", id })),
					},
				],
			},
		],
	});
	return addMetaBlock(
		buildXForm(doc, doc.formOrder[doc.moduleOrder[0]][0], {
			xmlns: "http://openrosa.org/formdesigner/case-splice-evidence",
		}),
	);
}
function subcase(
	closeCondition: FormActionCondition = neverCondition(),
): OpenSubCaseAction {
	return {
		doc_type: "OpenSubCaseAction",
		case_type: "visit",
		name_update: { question_path: "/data/child_name", update_mode: "always" },
		reference_id: "",
		case_properties: {
			weight: { question_path: "/data/weight", update_mode: "always" },
		},
		repeat_context: "",
		relationship: "child",
		close_condition: closeCondition,
		condition: alwaysCondition(),
	};
}

it("leaves an actual emitted form byte-identical when no actions need splicing", () => {
	const source = host();
	expect(addCaseBlocks(source, emptyFormActions(), "patient")).toBe(source);
});

it("binds updates and all preload metadata to the supplied selected-case identity", () => {
	const actions = emptyFormActions();
	actions.update_case.condition = alwaysCondition();
	actions.update_case.update = {
		weight: { question_path: "/data/weight", update_mode: "always" },
	};
	actions.case_preload.condition = alwaysCondition();
	actions.case_preload.preload = {
		"/data/weight": "weight",
		"/data/patient_name": "name",
		"/data/assigned_owner": "owner_id",
	};
	const selected = "instance('commcaresession')/session/data/case_id_child";
	const output = read(addCaseBlocks(host(), actions, "patient", selected));
	const block = child(output.data, "case");
	expect(block.attribs).toEqual({
		case_id: "",
		date_modified: "",
		user_id: "",
		xmlns: "http://commcarehq.org/case/transaction/v2",
	});
	expect(block.children.filter(isTag).map((e) => e.name)).toEqual(["update"]);
	expect(
		child(block, "update")
			.children.filter(isTag)
			.map((e) => e.name),
	).toEqual(["weight"]);
	expect(output.bind("/data/case/@case_id")).toEqual({
		nodeset: "/data/case/@case_id",
		calculate: selected,
	});
	expect(output.bind("/data/case/update/weight")).toEqual({
		nodeset: "/data/case/update/weight",
		calculate: "/data/weight",
		relevant: "count(/data/weight) > 0",
	});
	expect(
		output.modelNodes
			.filter((e) => e.name === "instance" && e.attribs.id === "casedb")
			.map((e) => e.attribs),
	).toEqual([{ id: "casedb", src: "jr://instance/casedb" }]);
	for (const [field, property] of [
		["weight", "weight"],
		["patient_name", "case_name"],
		["assigned_owner", "@owner_id"],
	]) {
		expect(output.seed(`/data/${field}`)).toEqual({
			ref: `/data/${field}`,
			event: "xforms-ready",
			value: `instance('casedb')/casedb/case[@case_id=${selected}]/${property}`,
		});
	}
});

it("joins parent and child create IDs, merges name requirements, and guards child property writes", () => {
	const actions = emptyFormActions();
	actions.open_case.condition = alwaysCondition();
	actions.open_case.name_update.question_path = "/data/patient_name";
	actions.subcases = [subcase()];
	const source = host();
	const before = read(source);
	const output = read(addCaseBlocks(source, actions, "patient"));
	const parent = child(output.data, "case");
	const visit = child(child(output.data, "subcase_0"), "case");
	expect([parent.attribs, visit.attribs]).toEqual([
		{
			case_id: "",
			date_modified: "",
			user_id: "",
			xmlns: "http://commcarehq.org/case/transaction/v2",
		},
		{
			case_id: "",
			date_modified: "",
			user_id: "",
			xmlns: "http://commcarehq.org/case/transaction/v2",
		},
	]);
	expect(
		child(visit, "update")
			.children.filter(isTag)
			.map((e) => e.name),
	).toEqual(["weight"]);
	expect(visit.children.filter(isTag).map((e) => e.name)).toEqual([
		"create",
		"update",
		"index",
	]);
	expect(child(child(visit, "index"), "parent").attribs).toEqual({
		case_type: "patient",
	});
	expect(
		child(visit, "create")
			.children.filter(isTag)
			.map((e) => e.name),
	).toEqual(["case_name", "owner_id", "case_type"]);
	for (const [path, datum] of [
		["/data/case", "case_id_new_patient_0"],
		["/data/subcase_0/case", "case_id_new_visit_1"],
	]) {
		expect(output.seed(`${path}/@case_id`)).toEqual({
			ref: `${path}/@case_id`,
			event: "xforms-ready",
			value: `instance('commcaresession')/session/data/${datum}`,
		});
		expect(output.bind(`${path}/create/owner_id`).calculate).toBe(
			"/data/meta/userID",
		);
	}
	for (const name of ["patient_name", "child_name"])
		expect(output.bind(`/data/${name}`)).toEqual({
			...before.bind(`/data/${name}`),
			required: "true()",
		});
	expect(output.bind("/data/subcase_0/case/index/parent")).toEqual({
		nodeset: "/data/subcase_0/case/index/parent",
		calculate: "/data/case/@case_id",
	});
	expect(output.bind("/data/subcase_0/case/update/weight")).toEqual({
		nodeset: "/data/subcase_0/case/update/weight",
		calculate: "/data/weight",
		relevant: "count(/data/weight) > 0",
	});
});

// Close-on-submit has no Nova authoring source today. Keep its private wire
// contract isolated here; this is not evidence of a product capability.
it.each([
	{
		name: "never",
		condition: neverCondition(),
		children: ["create", "update", "index"],
		binds: [],
	},
	{
		name: "always",
		condition: alwaysCondition(),
		children: ["create", "update", "close", "index"],
		binds: [],
	},
	{
		name: "conditional",
		condition: ifCondition("/data/done", "O'Brien & done <later>"),
		children: ["create", "update", "close", "index"],
		binds: [
			{
				nodeset: "/data/subcase_0/case/close",
				relevant: `/data/done = "O'Brien & done <later>"`,
			},
		],
	},
])(
	"scopes the $name subcase close to its own transaction",
	({ condition, children, binds }) => {
		const actions = emptyFormActions();
		actions.open_case.condition = alwaysCondition();
		actions.open_case.name_update.question_path = "/data/patient_name";
		actions.subcases = [subcase(condition)];
		const output = read(addCaseBlocks(host(), actions, "patient"));
		const block = child(child(output.data, "subcase_0"), "case");
		expect(block.children.filter(isTag).map((e) => e.name)).toEqual(children);
		expect(
			child(output.data, "case")
				.children.filter(isTag)
				.map((e) => e.name),
		).toEqual(["create"]);
		expect(
			output.modelNodes
				.filter(
					(e) =>
						e.name === "bind" &&
						e.attribs.nodeset === "/data/subcase_0/case/close",
				)
				.map((e) => e.attribs),
		).toEqual(binds);
	},
);
