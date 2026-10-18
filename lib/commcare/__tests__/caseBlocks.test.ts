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
import { proseText } from "@/lib/domain";
import { w } from "../xpath/wire/builders";
import { sessionInstance } from "../xpath/wire/instances";
import { caseOperationFixture } from "./caseOperationFixture";
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
			value: `instance('casedb')/casedb/case[@case_id = ${selected}]/${property}`,
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

// ── Case writes through basic actions ──────────────────────────────────

const TRIMMED_ANSWER = "replace(., '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')";
const EXTERNAL_ID_CHECK = `string-length(${TRIMMED_ANSWER}) <= 255`;
const NAME_CHECK = `string-length(${TRIMMED_ANSWER}) > 0 and ${EXTERNAL_ID_CHECK}`;
const trim = (path: string) =>
	`replace(${path}, '^[\\x00-\\x20]+|[\\x00-\\x20]+$', '')`;
const names = (parent: Element) =>
	parent.children.filter(isTag).map((e) => e.name);

/** Both export paths of a document's first form: HQ's source and the archive's. */
function bothExports(doc: ReturnType<typeof buildDoc>, formIndex = 0) {
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	const hq = expandDoc(doc);
	const form = hq.modules[0].forms[formIndex];
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
	closeCondition?: {
		field: string;
		answer: string;
		operator?: "=" | "selected";
	},
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
	const xml = host([
		...["zeta", "external", "alpha", "name", "Upper"].map((id) =>
			f({ kind: "text", id }),
		),
		...["scan", "badge"].map((id) => f({ kind: "image", id })),
	]);
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
		scan: "/data/scan",
		badge: "/data/badge",
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
		if (casePath !== "/data/commcare_usercase/case")
			expect(names(child(block, "attachment"))).toEqual(["badge", "scan"]);
	}
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
	for (const answer of ["it's", `say "it's"`]) {
		const doc = patientApp("close", [f({ kind: "text", id: "outcome" })], {
			field: "outcome",
			answer,
		});
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

it("writes a close condition still missing its answer, which the validator refuses, as an unconditional close action", () => {
	const doc = patientApp("close", [f({ kind: "text", id: "outcome" })], {
		field: "outcome",
		answer: "",
	});
	// The emitter stays total on a document the gate would refuse.
	const hq = expandDoc(doc);
	const form = hq.modules[0].forms[0];
	expect(form.actions.close_case.condition.type).toBe("always");
	const source = hq._attachments[`${form.unique_id}.xml`];
	if (typeof source !== "string") throw new Error("Missing form source");
	expect(
		read(source)
			.data.children.filter(isTag)
			.map((e) => e.name),
	).not.toContain("nova_operations");
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
	);
	const local = read(zip.readAsText("modules-0/forms-0.xml"));
	expect(names(child(local.data, "case"))).toEqual(["close"]);
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
		{ field: "outcome", answer: "done" },
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
	if (answer === undefined) throw new Error("Missing answer question");
	Object.assign(answer, {
		caseWrite: { caseType: "visit", property: "case_name" },
	});
	const hq = expandDoc(doc);
	const zip = new AdmZip(
		compileCcz(hq, doc.appName, doc, { runtimeTarget: TEST_RUNTIME_TARGET }),
	);
	const local = read(zip.readAsText("modules-0/forms-0.xml"));
	const items = child(local.data, "items");
	expect(names(items)).toEqual([
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
