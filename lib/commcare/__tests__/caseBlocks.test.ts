import AdmZip from "adm-zip";
import { type Element, isTag } from "domhandler";
import { parseDocument } from "htmlparser2";
import { SaxesParser } from "saxes";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	type FieldSpec,
	f,
} from "@/lib/__tests__/docHelpers";
import {
	alwaysCondition,
	emptyFormActions,
	type FormActionCondition,
	ifCondition,
	neverCondition,
	type OpenSubCaseAction,
} from "@/lib/commcare";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import { buildXForm } from "@/lib/commcare/xform/builder";
import { addCaseBlocks } from "@/lib/commcare/xform/caseBlocks";
import { addMetaBlock } from "@/lib/commcare/xform/metaBlock";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { type CaseOperation, proseText } from "@/lib/domain";
import { w } from "../xpath/wire/builders";
import { sessionInstance } from "../xpath/wire/instances";
import { caseOperationFixture } from "./caseOperationFixture";
import { basicForm } from "./hqBasicShape";
import { TEST_RUNTIME_TARGET } from "./runtimeTargetFixture";

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
	new SaxesParser({ xmlns: true }).write(xml).close();
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
function host(
	fields: FieldSpec[] = [
		"patient_name",
		"child_name",
		"weight",
		"assigned_owner",
		"done",
	].map((id) => f({ kind: "text", id })),
) {
	const doc = buildDoc({
		modules: [
			{
				name: "Questions",
				forms: [{ name: "Record", type: "survey", fields }],
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

it("binds updates to the supplied selected-case identity, and writes no preload", () => {
	const actions = emptyFormActions();
	actions.update_case.condition = alwaysCondition();
	actions.update_case.update = {
		weight: { question_path: "/data/weight", update_mode: "always" },
	};
	const selected = "instance('commcaresession')/session/data/case_id_child";
	const selectedPath = w.instance(sessionInstance(), [
		w.step("session"),
		w.step("data"),
		w.step("case_id_child"),
	]);
	const output = read(addCaseBlocks(host(), actions, "patient", selectedPath));
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
	// A preload is the question's default, written at its place in the
	// source: the archive seeds no question from the case.
	expect(
		output.modelNodes.filter(
			(e) => e.name === "setvalue" && !e.attribs.ref.startsWith("/data/meta/"),
		),
	).toEqual([]);
});

// HQ's build writes a row saved only when the answer changed with the
// comparison `XFormCaseBlock.add_case_updates` adds under
// `SAVE_ONLY_EDITED_FORM_FIELDS`, and a key through an index into a block of
// the case that index reaches (`XForm._add_case_updates`, its id
// `get_case_parent_id_xpath`). The archive writes the same blocks.
it("compares an answer saved only if changed with the case's value when the form opened", () => {
	const actions = emptyFormActions();
	actions.update_case.condition = alwaysCondition();
	actions.update_case.update = {
		weight: { question_path: "/data/weight", update_mode: "edit" },
		name: { question_path: "/data/patient_name", update_mode: "edit" },
	};
	const output = read(addCaseBlocks(host(), actions, "patient"));
	expect(output.bind("/data/case/update/weight")).toEqual({
		nodeset: "/data/case/update/weight",
		calculate: "/data/weight",
		relevant:
			"count(/data/weight) > 0 and instance('casedb')/casedb/case[@case_id = /data/case/@case_id]/weight != /data/weight",
	});
	expect(output.bind("/data/case/update/case_name").relevant).toBe(
		"count(/data/patient_name) > 0 and instance('casedb')/casedb/case[@case_id = /data/case/@case_id]/case_name != /data/patient_name",
	);
	expect(
		output.modelNodes
			.filter((e) => e.name === "instance" && e.attribs.id === "casedb")
			.map((e) => e.attribs),
	).toEqual([{ id: "casedb", src: "jr://instance/casedb" }]);
});

it("writes a key through an index into a block of the case that index reaches", () => {
	const actions = emptyFormActions();
	actions.update_case.condition = alwaysCondition();
	actions.update_case.update = {
		weight: { question_path: "/data/weight", update_mode: "always" },
		"parent/done": { question_path: "/data/done", update_mode: "edit" },
		"parent/host/assigned": {
			question_path: "/data/assigned_owner",
			update_mode: "always",
		},
	};
	const output = read(addCaseBlocks(host(), actions, "patient"));
	// The own block keeps only its own key; the ancestors stand under
	// `parents`, before the own block, each chain built afresh as HQ builds
	// it.
	expect(names(child(child(output.data, "case"), "update"))).toEqual([
		"weight",
	]);
	expect(names(output.data).slice(-2)).toEqual(["parents", "case"]);
	const parents = child(output.data, "parents");
	expect(names(parents)).toEqual(["parent", "parent"]);
	const [direct, through] = parents.children.filter(isTag);
	expect(names(direct)).toEqual(["case"]);
	expect(names(child(child(through, "host"), "case"))).toEqual(["update"]);
	const session = "instance('commcaresession')/session/data/case_id";
	const parentId = `instance('casedb')/casedb/case[@case_id = ${session}]/index/parent`;
	expect(output.bind("/data/parents/parent/case/@case_id")).toEqual({
		nodeset: "/data/parents/parent/case/@case_id",
		calculate: parentId,
	});
	expect(output.bind("/data/parents/parent/host/case/@case_id")).toEqual({
		nodeset: "/data/parents/parent/host/case/@case_id",
		calculate: `instance('casedb')/casedb/case[@case_id = ${parentId}]/index/host`,
	});
	expect(output.bind("/data/parents/parent/case/update/done")).toEqual({
		nodeset: "/data/parents/parent/case/update/done",
		calculate: "/data/done",
		relevant:
			"count(/data/done) > 0 and instance('casedb')/casedb/case[@case_id = /data/parents/parent/case/@case_id]/done != /data/done",
	});
	expect(output.bind("/data/parents/parent/host/case/update/assigned")).toEqual(
		{
			nodeset: "/data/parents/parent/host/case/update/assigned",
			calculate: "/data/assigned_owner",
			relevant: "count(/data/assigned_owner) > 0",
		},
	);
	for (const path of [
		"/data/parents/parent/case",
		"/data/parents/parent/host/case",
	]) {
		expect(output.bind(`${path}/@date_modified`).calculate).toBe(
			"/data/meta/timeEnd",
		);
		expect(output.bind(`${path}/@user_id`).calculate).toBe("/data/meta/userID");
	}
});

it("states a yes-or-no question's own truth as a close condition", () => {
	const actions = emptyFormActions();
	actions.update_case.condition = alwaysCondition();
	actions.close_case.condition = {
		type: "if",
		question: "/data/done",
		answer: null,
		operator: "boolean_true",
		doc_type: "FormActionCondition",
	};
	const output = read(addCaseBlocks(host(), actions, "patient"));
	expect(names(child(output.data, "case"))).toEqual(["close"]);
	expect(output.bind("/data/case/close")).toEqual({
		nodeset: "/data/case/close",
		relevant: "/data/done",
	});
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

// ── Case writes through basic actions ──────────────────────────────────

const TRIMMED_ANSWER = "replace(., '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')";
const EXTERNAL_ID_CHECK = `string-length(${TRIMMED_ANSWER}) <= 255`;
const NAME_CHECK = `string-length(${TRIMMED_ANSWER}) > 0 and ${EXTERNAL_ID_CHECK}`;
const trim = (path: string) =>
	`replace(${path}, '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')`;
const names = (parent: Element) =>
	parent.children.filter(isTag).map((e) => e.name);

/** Both export paths of a document's first form: HQ's source and the archive's. */
function bothExports(
	doc: ReturnType<typeof buildDoc>,
	formIndex = 0,
	attachmentTarget?: { origin: string; domain: string },
) {
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const hq = expandDoc(doc, attachmentTarget && { attachmentTarget });
	const form = basicForm(hq, 0, formIndex);
	const source = hq._attachments[`${form.unique_id}.xml`];
	if (typeof source !== "string") throw new Error("Missing form source");
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
	);
	return {
		actions: form.actions,
		source: read(source),
		local: read(zip.readAsText(`modules-0/forms-${formIndex}.xml`)),
	};
}

function patientApp(
	type: "registration" | "followup" | "close",
	fields: FieldSpec[],
	/** The close form's close condition, as form text. */
	closeCondition?: string,
) {
	return buildDoc({
		appName: "Case writes",
		caseTypes: [
			{
				name: "patient",
				properties: [
					"case_name",
					"external_id",
					"zeta",
					"alpha",
					"outcome",
				].map((name) => ({ name, label: proseText(name) })),
			},
			{
				name: "visit",
				parent_type: "patient",
				properties: [{ name: "case_name", label: proseText("Name") }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Record",
						type,
						fields,
						...(closeCondition !== undefined && { closeCondition }),
					},
				],
			},
			{
				name: "Visits",
				caseType: "visit",
				caseListOnly: true,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [],
			},
		],
	});
}

const write = (property: string, caseType = "patient") => ({
	caseWrite: { caseType, property },
});

it("touches the selected case on a follow-up that writes nothing, with no update child", () => {
	const actions = emptyFormActions();
	actions.update_case.condition = alwaysCondition();
	const touch = read(addCaseBlocks(host(), actions, "patient"));
	const block = child(touch.data, "case");
	expect(names(block)).toEqual([]);
	for (const [path, attribs] of [
		[
			"/data/case/@case_id",
			{ calculate: "instance('commcaresession')/session/data/case_id" },
		],
		[
			"/data/case/@date_modified",
			{ type: "xsd:dateTime", calculate: "/data/meta/timeEnd" },
		],
		["/data/case/@user_id", { calculate: "/data/meta/userID" }],
	] as const)
		expect(touch.bind(path)).toEqual({ nodeset: path, ...attribs });
	actions.update_case.update = {
		weight: { question_path: "/data/weight", update_mode: "always" },
	};
	const writing = read(addCaseBlocks(host(), actions, "patient"));
	expect(names(child(writing.data, "case"))).toEqual(["update"]);
});

it("writes update children and their binds in name order for every block", () => {
	// Python orders HQ's update keys by code point, so an uppercase name
	// stands before every lowercase one (`XFormCaseBlock.add_case_updates`).
	const xml = host(
		["zeta", "external", "alpha", "name", "Upper"].map((id) =>
			f({ kind: "text", id }),
		),
	);
	const writes = (
		paths: Record<string, string>,
	): Record<string, { question_path: string; update_mode: string }> =>
		Object.fromEntries(
			Object.entries(paths).map(([property, path]) => [
				property,
				{ question_path: path, update_mode: "always" },
			]),
		);
	const listed = {
		zeta: "/data/zeta",
		external_id: "/data/external",
		alpha: "/data/alpha",
		name: "/data/name",
		Upper: "/data/Upper",
	};
	const actions = emptyFormActions();
	actions.open_case.condition = alwaysCondition();
	actions.open_case.name_update.question_path = "/data/name";
	actions.update_case.condition = alwaysCondition();
	actions.update_case.update = writes(listed);
	const { name: _name, ...subcaseWrites } = listed;
	actions.subcases = [{ ...subcase(), case_properties: writes(subcaseWrites) }];
	actions.usercase_update.condition = alwaysCondition();
	actions.usercase_update.update = writes({
		zeta: "/data/zeta",
		alpha: "/data/alpha",
		Upper: "/data/Upper",
	});
	const output = read(addCaseBlocks(xml, actions, "patient"));
	const ordered = ["Upper", "alpha", "case_name", "external_id", "zeta"];
	for (const [casePath, block, properties] of [
		["/data/case", child(output.data, "case"), ordered],
		[
			"/data/subcase_0/case",
			child(child(output.data, "subcase_0"), "case"),
			ordered.filter((name) => name !== "case_name"),
		],
		[
			"/data/commcare_usercase/case",
			child(child(output.data, "commcare_usercase"), "case"),
			["Upper", "alpha", "zeta"],
		],
	] as const) {
		expect(names(child(block, "update"))).toEqual(properties);
		expect(
			output.modelNodes
				.filter(
					(e) =>
						e.name === "bind" &&
						e.attribs.nodeset.startsWith(`${casePath}/update/`),
				)
				.map((e) => e.attribs.nodeset.slice(`${casePath}/update/`.length)),
		).toEqual(properties);
	}
});

it("writes a capture's case write as an update reading its link sibling on both paths, with no attachment", () => {
	// HQ's build turns an update whose question path is an upload question
	// into an `<attachment>` (`xform.py::XFormCaseBlock.add_case_updates`,
	// `::is_attachment`), which a project space without `MM_CASE_PROPERTIES`
	// drops. Every capture's write names its link sibling instead, on the
	// primary case, on a child case, and in HQ's source as in the archive.
	const doc = patientApp("registration", [
		f({ kind: "text", id: "name", ...write("case_name") }),
		f({ kind: "image", id: "photo", ...write("alpha") }),
		f({
			kind: "repeat",
			id: "visits",
			repeat_mode: "user_controlled",
			children: [
				f({ kind: "text", id: "visit_name", ...write("case_name", "visit") }),
				f({ kind: "file", id: "scan", ...write("zeta", "visit") }),
			],
		}),
	]);
	const { actions, source, local } = bothExports(doc, 0, {
		origin: "https://www.commcarehq.org",
		domain: "demo-project",
	});
	expect(actions.update_case.update.alpha.question_path).toBe(
		"/data/nova_url_photo",
	);
	expect(actions.subcases[0].case_properties.zeta.question_path).toBe(
		"/data/visits/nova_url_scan",
	);
	for (const form of [source, local]) {
		expect(form.bind("/data/nova_url_photo").relevant).toBe(
			"count(/data/photo) > 0",
		);
		expect(form.bind("/data/visits/nova_url_scan").relevant).toBe(
			"count(/data/visits/scan) > 0",
		);
	}
	for (const [casePath, link] of [
		["/data/case", "/data/nova_url_photo"],
		["/data/visits/case", "/data/visits/nova_url_scan"],
	] as const) {
		const property = casePath === "/data/case" ? "alpha" : "zeta";
		expect(local.bind(`${casePath}/update/${property}`)).toEqual({
			nodeset: `${casePath}/update/${property}`,
			calculate: link,
			relevant: `count(${link}) > 0`,
		});
	}
	expect(names(child(child(local.data, "case"), "update"))).toEqual(["alpha"]);
	for (const form of [source, local])
		expect(
			form.modelNodes.filter(
				(e) => e.name === "bind" && e.attribs.nodeset.includes("/attachment"),
			),
		).toEqual([]);
	expect(names(child(child(local.data, "visits"), "case"))).not.toContain(
		"attachment",
	);
	expect(names(child(local.data, "case"))).not.toContain("attachment");
});

it("names each case name and external id by the question's trimmed sibling and checks the visible question", () => {
	const doc = patientApp("registration", [
		f({ kind: "text", id: "name", required: "true()", ...write("case_name") }),
		f({ kind: "text", id: "external", ...write("external_id") }),
		f({ kind: "text", id: "nova_trimmed_external" }),
		f({
			kind: "repeat",
			id: "visits",
			repeat_mode: "user_controlled",
			children: [
				f({
					kind: "hidden",
					id: "visit_name",
					calculate: "'Visit'",
					...write("case_name", "visit"),
				}),
			],
		}),
	]);
	const { actions, source, local } = bothExports(doc);
	// An authored question named like the sibling takes it; the sibling steps
	// around it with a suffix.
	const trimmedExternal = "/data/nova_trimmed_external_1";
	expect(actions.open_case.name_update.question_path).toBe(
		"/data/nova_trimmed_name",
	);
	expect(actions.open_case.external_id).toBeNull();
	expect(actions.update_case.update.external_id.question_path).toBe(
		trimmedExternal,
	);
	expect(actions.subcases[0].name_update.question_path).toBe(
		"/data/visits/nova_trimmed_visit_name",
	);
	for (const form of [source, local]) {
		for (const [path, question] of [
			["/data/nova_trimmed_name", "/data/name"],
			[trimmedExternal, "/data/external"],
			["/data/visits/nova_trimmed_visit_name", "/data/visits/visit_name"],
		] as const) {
			const { required: _stamp, ...bind } = form.bind(path);
			expect(bind).toEqual({
				nodeset: path,
				calculate: trim(question),
				relevant: `count(${question}) > 0`,
			});
		}
		// The visible name question is required on its one bind and carries
		// the check; the external id takes the length half; a Hidden Value
		// takes neither.
		expect(form.bind("/data/name")).toMatchObject({
			required: "true()",
			constraint: NAME_CHECK,
		});
		expect(form.bind("/data/external").constraint).toBe(EXTERNAL_ID_CHECK);
		expect(form.bind("/data/visits/visit_name").constraint).toBeUndefined();
		expect(form.bind("/data/visits/visit_name").required).toBeUndefined();
	}
	// The archive's leaves read the action's path as it stands, with no trim
	// of their own, and stamp HQ's inert requirement on the sibling.
	expect(local.bind("/data/case/create/case_name").calculate).toBe(
		"/data/nova_trimmed_name",
	);
	expect(local.bind("/data/nova_trimmed_name").required).toBe("true()");
	expect(local.bind("/data/case/update/external_id")).toEqual({
		nodeset: "/data/case/update/external_id",
		calculate: trimmedExternal,
		relevant: `count(${trimmedExternal}) > 0`,
	});
	expect(names(child(child(local.data, "case"), "update"))).toEqual([
		"external_id",
	]);
	expect(local.bind("/data/visits/case/create/case_name").calculate).toBe(
		"/data/visits/nova_trimmed_visit_name",
	);
});

it("states the requirement in place of an authored required condition on a create name", () => {
	const doc = patientApp("registration", [
		f({ kind: "text", id: "flag" }),
		f({
			kind: "text",
			id: "name",
			required: "#form/flag = 'yes'",
			...write("case_name"),
		}),
	]);
	const { source } = bothExports(doc);
	const binds = source.modelNodes.filter(
		(e) => e.name === "bind" && e.attribs.nodeset === "/data/name",
	);
	expect(binds).toHaveLength(1);
	expect(binds[0]?.attribs.required).toBe("true()");
	expect(binds[0]?.attribs["vellum:requiredCondition"]).toBeUndefined();
});

it("writes a close the Case Management tab cannot state as a Save to Case close", () => {
	for (const [answer, condition] of [
		["it's", `#form/outcome = "it's"`],
		[`say "it's"`, `#form/outcome = concat('say "it', "'", 's"')`],
	] as const) {
		const doc = patientApp(
			"close",
			[f({ kind: "text", id: "outcome" })],
			condition,
		);
		const { actions, source, local } = bothExports(doc);
		expect(actions.close_case.condition.type).toBe("never");
		expect(actions.update_case.condition.type).toBe("always");
		const literal = answer.includes('"')
			? `concat('say "it', "'", 's"')`
			: `"it's"`;
		for (const form of [source, local]) {
			const operations = child(form.data, "nova_operations");
			const group = child(operations, "nova_condition_close");
			const block = child(group, "nova_close");
			// The archive strips `vellum:` attributes; HQ's source keeps them.
			expect(block.attribs).toEqual(
				form === source
					? { "vellum:role": "SaveToCase", "vellum:case_type": "patient" }
					: {},
			);
			expect(names(child(block, "case"))).toEqual(["close"]);
			const base = "/data/nova_operations/nova_condition_close";
			expect(form.bind(base)).toEqual({
				nodeset: base,
				relevant: `/data/outcome = ${literal}`,
			});
			expect(form.bind(`${base}/nova_close/case/@case_id`)).toEqual({
				nodeset: `${base}/nova_close/case/@case_id`,
				calculate: "instance('commcaresession')/session/data/case_id",
			});
			expect(
				form.modelNodes.some(
					(e) => e.name === "instance" && e.attribs.id === "commcaresession",
				),
			).toBe(true);
		}
		// The archive's primary block touches the case and holds no close.
		expect(names(child(local.data, "case"))).toEqual([]);
	}
});

it("keeps a statable close on HQ's close action", () => {
	const doc = patientApp(
		"close",
		[
			f({
				kind: "single_select",
				id: "outcome",
				optionsSource: {
					kind: "inline",
					options: ["done", "moved"].map((value) => ({
						value,
						label: proseText(value),
						uuid: testUuid(`option-${value}`),
					})),
				},
			}),
		],
		"#form/outcome = 'done'",
	);
	const { actions, source, local } = bothExports(doc);
	expect(actions.close_case.condition).toMatchObject({
		type: "if",
		question: "/data/outcome",
		answer: "done",
	});
	expect(source.data.children.filter(isTag).map((e) => e.name)).not.toContain(
		"nova_operations",
	);
	expect(names(child(local.data, "case"))).toEqual(["close"]);
});

it("puts a repeat's single subcase block first in its item, before the item's Save to Case blocks", () => {
	const doc = caseOperationFixture("repeat");
	const answer = Object.values(doc.fields).find(
		(field) => field.id === "answer",
	);
	const items = Object.values(doc.fields).find((field) => field.id === "items");
	const form = Object.values(doc.forms)[0];
	if (answer === undefined || items === undefined || form === undefined)
		throw new Error("The fixture holds its repeat and its answer");
	// A visit named by the row's answer, a child of the loaded patient: the
	// repeat's one basic subcase.
	form.caseOperations?.splice(1, 0, {
		uuid: testUuid("basic-visit"),
		id: "basic_visit",
		action: "create",
		caseType: "visit",
		target: { kind: "new" },
		name: { kind: "term", term: { kind: "field", uuid: answer.uuid } },
		links: [
			{
				identifier: "parent",
				targetType: "patient",
				target: { kind: "session" },
				relationship: "child",
			},
		],
		forEach: { repeat: items.uuid },
	} as CaseOperation);
	const hq = expandDoc(doc);
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
	);
	const local = read(zip.readAsText("modules-0/forms-0.xml"));
	expect(names(child(local.data, "items"))).toEqual([
		"case",
		"answer",
		"nova_trimmed_answer",
		"key",
		"nova_operations",
	]);
	// The data node's own order is HQ's: fields, then the form's own case,
	// then meta.
	expect(names(local.data).slice(-2)).toEqual(["case", "orx:meta"]);
});
